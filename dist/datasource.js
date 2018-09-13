"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// @ts-ignore
var kbn = require("app/core/utils/kbn");
var ApmDatasource = /** @class */ (function () {
    function ApmDatasource(instanceSettings, $q, backendSrv, templateSrv) {
        this.$q = $q;
        this.backendSrv = backendSrv;
        this.templateSrv = templateSrv;
        this.soapHead = '<soapenv:Envelope xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\" xmlns:xsd=\"http://www.w3.org/2001/XMLSchema\" xmlns:soapenv=\"http://schemas.xmlsoap.org/soap/envelope/\" xmlns:met=\"http://metricslist.webservicesimpl.server.introscope.wily.com\"><soapenv:Header/><soapenv:Body>';
        this.soapTail = '</soapenv:Body></soapenv:Envelope>';
        this.url = instanceSettings.url;
        this.templateSrv = templateSrv;
        if (window.DOMParser) {
            this.parser = new DOMParser();
        }
    }
    ApmDatasource.prototype.query = function (options) {
        var _this = this;
        var startTime = options.range.from.toISOString();
        var endTime = options.range.to.toISOString();
        var grafanaResponse = { data: [] };
        var requests = options.targets.map(function (target) {
            return new Promise(function (resolve) {
                if (target.hide || !target.rawQuery) {
                    resolve();
                }
                else {
                    var query = target.rawQuery;
                    var agentRegex = "" || query.agentRegex;
                    var metricRegex = "" || query.metricRegex;
                    var dataFrequency = "" || query.temporalResolution;
                    if (!(agentRegex && metricRegex && dataFrequency)) {
                        resolve();
                    }
                    // escape common metric path characters ("|", "(", ")")
                    if (query.isAutoEscapingEnabled) {
                        agentRegex = _this.escapeQueryString(agentRegex);
                        metricRegex = _this.escapeQueryString(metricRegex);
                    }
                    // replace variables
                    agentRegex = _this.templateSrv.replace(agentRegex, options.scopedVars, 'regex');
                    metricRegex = _this.templateSrv.replace(metricRegex, options.scopedVars, 'regex');
                    dataFrequency = _this.templateSrv.replace("" + dataFrequency, options.scopedVars, 'regex');
                    var headers = {
                        "SOAPAction": "getMetricData",
                        "Content-Type": "text/xml"
                    };
                    var dataFrequencyInSeconds = kbn.interval_to_seconds(dataFrequency);
                    dataFrequencyInSeconds = dataFrequencyInSeconds - (dataFrequencyInSeconds % 15);
                    if (dataFrequencyInSeconds == 0) {
                        dataFrequencyInSeconds = 15;
                    }
                    _this.backendSrv.datasourceRequest({
                        url: _this.url + '/introscope-web-services/services/MetricsDataService',
                        method: 'POST',
                        headers: headers,
                        data: _this.getSoapBodyForMetricsQuery(agentRegex, metricRegex, startTime, endTime, dataFrequencyInSeconds)
                    }).then(function (response) {
                        _this.parseResponseData(response.data, grafanaResponse);
                        resolve();
                    });
                }
            });
        });
        return Promise.all(requests).then(function () {
            return grafanaResponse;
        });
    };
    ApmDatasource.prototype.metricFindQuery = function (query) {
        if (query.lastIndexOf("Agents|", 0) === 0) {
            var agentRegex = query.substring(7);
            return this.getAgentSegments(agentRegex).then(function (agents) {
                return agents.map(function (agent) {
                    return { text: agent };
                });
            });
        }
        else if (query.lastIndexOf("Metrics|", 0) === 0) {
            var metricRegex = query.substring(8);
            return this.getMetricSegments(".*", metricRegex).then(function (metrics) {
                return metrics.map(function (metric) {
                    return { text: metric };
                });
            });
        }
        else {
            return Promise.resolve([]);
        }
    };
    ApmDatasource.prototype.testDatasource = function () {
        var _this = this;
        return this.backendSrv.datasourceRequest({
            url: this.url + '/introscope-web-services/services/MetricsDataService?wsdl',
            method: 'GET',
        }).then(function (response) {
            if (response.status === 200) {
                var xml = _this.parser.parseFromString(response.data, "text/xml");
                if (xml.getElementsByTagName("wsdl:service")[0].getAttribute("name") === "MetricsDataService") {
                    return { status: 'success', message: 'Data source is working, found Metrics Data Web Service', title: 'Success' };
                }
            }
            return { status: 'failure', message: 'Data source is not working: ' + response.status, title: 'Failure' };
        });
    };
    ApmDatasource.prototype.parseResponseData = function (responseData, grafanaResponse) {
        //let rawArray;
        var returnCount;
        var rawArray;
        try {
            var xml = this.parser.parseFromString(responseData, "text/xml");
            returnCount = xml.getElementsByTagName("ns1:getMetricDataResponse")[0].childNodes[0].childNodes.length;
            if (returnCount != 0) {
                // response array is not empty
                rawArray = xml.getElementsByTagName("multiRef");
            }
            else {
                // response array was empty
                return grafanaResponse;
            }
        }
        catch (exception) {
            console.log("Cannot parse query response:");
            console.log(exception);
            return grafanaResponse;
        }
        var slices = [];
        var metricData = {};
        var metrics = {};
        var legendSeparator = "|";
        var references;
        // first process the time slices
        for (var i = 0; i < returnCount; i++) {
            var slice = rawArray[i];
            references = [];
            slice.childNodes[0].childNodes.forEach(function (x) {
                references.push(+x.getAttribute("href").split("#id")[1]);
            });
            slices.push({
                id: i + 1,
                references: references,
                endTime: Date.parse(slice.childNodes[1].textContent)
            });
        }
        ;
        // then collect the actual data points into a map
        for (var i = returnCount; i < rawArray.length; i++) {
            var rawMetricDataPoint = rawArray[i];
            var id = rawMetricDataPoint.getAttribute("id").split("id")[1];
            var value = null;
            // handle missing values explicitly           
            if (!(rawMetricDataPoint.childNodes[3].getAttribute("xsi:nil") === "true")) {
                // we have a value, convert to int implicitly
                value = +rawMetricDataPoint.childNodes[3].textContent;
            }
            metricData[id] = {
                agentName: rawMetricDataPoint.childNodes[0].textContent,
                metricName: rawMetricDataPoint.childNodes[1].textContent,
                metricValue: value
            };
        }
        ;
        // for each time slice, collect all referenced data points
        slices.forEach(function (slice) {
            slice.references.forEach(function (reference) {
                var dataPoint = metricData[reference];
                metrics[dataPoint.agentName + legendSeparator + dataPoint.metricName] = metrics[dataPoint.agentName + legendSeparator + dataPoint.metricName] || [];
                metrics[dataPoint.agentName + legendSeparator + dataPoint.metricName].push([dataPoint.metricValue, slice.endTime]);
            });
        });
        // sort the data points for proper line display in Grafana and add all series to the response
        Object.keys(metrics).forEach(function (metric) {
            metrics[metric].sort(function (a, b) {
                return a[1] - b[1];
            });
            grafanaResponse.data.push({
                target: metric,
                datapoints: metrics[metric]
            });
        });
    };
    ApmDatasource.prototype.escapeQueryString = function (queryString) {
        return (queryString + '').replace(new RegExp('[|()]', 'g'), '\\$&');
    };
    ApmDatasource.prototype.getSoapBodyForMetricsQuery = function (agentRegex, metricRegex, startTime, endTime, dataFrequency) {
        return this.soapHead
            + '<met:getMetricData soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><agentRegex xsi:type="xsd:string">'
            + agentRegex
            + '</agentRegex><metricRegex xsi:type="xsd:string">'
            + metricRegex
            + '</metricRegex><startTime xsi:type="xsd:dateTime">'
            + startTime
            + '</startTime><endTime xsi:type="xsd:dateTime">'
            + endTime
            + '</endTime><dataFrequency xsi:type="xsd:int">'
            + dataFrequency
            + '</dataFrequency></met:getMetricData></soapenv:Body></soapenv:Envelope>';
    };
    ApmDatasource.prototype.getAgentSegments = function (agentRegex) {
        var _this = this;
        var preprocessedAgentRegex = this.escapeQueryString(this.templateSrv.replace(agentRegex));
        var headers = {
            "SOAPAction": "listAgents",
            "Content-Type": "text/xml"
        };
        return this.backendSrv.datasourceRequest({
            url: this.url + '/introscope-web-services/services/MetricsListService',
            method: 'POST',
            headers: headers,
            data: this.soapHead
                + "<met:listAgents soapenv:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><agentRegex xsi:type=\"xsd:string\">"
                + preprocessedAgentRegex
                + ".*"
                + "</agentRegex></met:listAgents></soapenv:Body></soapenv:Envelope>"
        }).then(function (response) {
            if (response.status === 200) {
                var xml = _this.parser.parseFromString(response.data, "text/xml");
                var agentPaths_1 = [];
                xml.getElementsByTagName("ns1:listAgentsResponse")[0].childNodes[0].childNodes.forEach(function (x) {
                    agentPaths_1.push(x.textContent);
                });
                return agentPaths_1;
            }
            else {
                return [];
            }
        }).catch(function (error) {
            return [];
        });
    };
    ApmDatasource.prototype.getMetricSegments = function (agentRegex, metricRegex) {
        var _this = this;
        var preprocessedAgentRegex = this.escapeQueryString(this.templateSrv.replace(agentRegex));
        var preprocessedMetricRegex = this.escapeQueryString(this.templateSrv.replace(metricRegex));
        var headers = {
            "SOAPAction": "listMetrics",
            "Content-Type": "text/xml"
        };
        return this.backendSrv.datasourceRequest({
            url: this.url + '/introscope-web-services/services/MetricsListService',
            method: 'POST',
            headers: headers,
            data: this.soapHead
                + "<met:listMetrics soapenv:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><agentRegex xsi:type=\"xsd:string\">"
                + preprocessedAgentRegex
                + ".*"
                + "</agentRegex><metricRegex xsi:type=\"xsd:string\">"
                + preprocessedMetricRegex
                + ".*"
                + "</metricRegex></met:listMetrics></soapenv:Body></soapenv:Envelope>"
        }).then(function (response) {
            if (response.status === 200) {
                var metricPaths = [];
                var xml = _this.parser.parseFromString(response.data, "text/xml");
                var collection = xml.getElementsByTagName("multiRef");
                for (var i = 0; i < collection.length; i++) {
                    var item = collection.item(i);
                    metricPaths.push(item.childNodes[1].textContent);
                }
                return metricPaths;
            }
            else {
                return [];
            }
        }).catch(function (error) {
            console.log(error);
            return [];
        });
    };
    return ApmDatasource;
}());
exports.ApmDatasource = ApmDatasource;
