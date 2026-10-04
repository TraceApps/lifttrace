/**
 * Optional Prometheus metrics for HTTP requests, off unless
 * METRICS_ENABLED=true. One histogram, named after the OpenTelemetry HTTP
 * semantic conventions so standard dashboards and alerts work unchanged:
 *
 *   http_server_request_duration_seconds{http_request_method, http_route,
 *                                        http_response_status_code}
 *
 * The route label is Express's route pattern (`/api/workout/:date`), never the
 * raw path, so the number of series stays small. The frontend's catch-all
 * shows up as its own pattern, `/{*splat}`, and requests no route handled
 * (static files) share the route "other".
 *
 * The metrics are served on their own port (METRICS_PORT, default 9464, the
 * OpenTelemetry Prometheus exporter's port), not the app's, so they're
 * reachable from inside the cluster or host only, never through a public
 * proxy or tunnel. No dependencies: this writes the Prometheus text format
 * directly.
 */
import http from 'node:http';

// OpenTelemetry's default buckets for http.server.request.duration, in seconds.
export const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

const METRIC = 'http_server_request_duration_seconds';

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labelString(labels) {
  return Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
}

export function createMetrics({ buckets = DEFAULT_BUCKETS } = {}) {
  const sorted = [...buckets].sort((a, b) => a - b);
  // key -> { labels, counts per bucket (non-cumulative), sum, count }
  const series = new Map();

  function observe({ method, route, status }, seconds) {
    const labels = {
      http_request_method: method,
      http_response_status_code: String(status),
      http_route: route,
    };
    const key = labelString(labels);
    let s = series.get(key);
    if (!s) {
      s = { labels, counts: new Array(sorted.length).fill(0), sum: 0, count: 0 };
      series.set(key, s);
    }
    const i = sorted.findIndex((b) => seconds <= b);
    if (i !== -1) s.counts[i] += 1;
    s.sum += seconds;
    s.count += 1;
  }

  function render() {
    const lines = [
      `# HELP ${METRIC} Duration of HTTP server requests.`,
      `# TYPE ${METRIC} histogram`,
    ];
    for (const s of series.values()) {
      const base = labelString(s.labels);
      let cumulative = 0;
      sorted.forEach((b, i) => {
        cumulative += s.counts[i];
        lines.push(`${METRIC}_bucket{${base},le="${b}"} ${cumulative}`);
      });
      lines.push(`${METRIC}_bucket{${base},le="+Inf"} ${s.count}`);
      lines.push(`${METRIC}_sum{${base}} ${s.sum}`);
      lines.push(`${METRIC}_count{${base}} ${s.count}`);
    }
    return lines.join('\n') + '\n';
  }

  return { observe, render };
}

/** The route pattern Express matched, or "other". */
export function routeLabel(req) {
  if (!req.route || req.route.path == null) return 'other';
  const path = typeof req.route.path === 'string' ? req.route.path : String(req.route.path);
  // A sub-router's root route is "/", which would leave "/api/exercises/".
  if (req.baseUrl && path === '/') return req.baseUrl;
  return `${req.baseUrl || ''}${path}` || '/';
}

/** Express middleware that times every request into `metrics`. */
export function metricsMiddleware(metrics) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      metrics.observe({ method: req.method, route: routeLabel(req), status: res.statusCode }, seconds);
    });
    next();
  };
}

/** Serves GET /metrics on its own port. Returns the http.Server. */
export function startMetricsServer(metrics, { port = 9464, host = '0.0.0.0' } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.split('?')[0] === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metrics.render());
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found\n');
  });
  server.listen(port, host);
  return server;
}
