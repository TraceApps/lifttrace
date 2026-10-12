// Tests for server/lib/metrics.js, the optional Prometheus metrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMetrics, routeLabel, startMetricsServer, DEFAULT_BUCKETS } from '../server/lib/metrics.js';

const labels = { method: 'GET', route: '/api/workout/:date', status: 200 };

test('buckets are cumulative, with +Inf, _sum and _count', () => {
  const m = createMetrics({ buckets: [0.1, 1] });
  m.observe(labels, 0.05);
  m.observe(labels, 0.5);
  m.observe(labels, 3);
  const out = m.render();
  const base = 'http_request_method="GET",http_response_status_code="200",http_route="/api/workout/:date"';
  assert.match(out, new RegExp(`_bucket\\{${base},le="0.1"\\} 1\\n`));
  assert.match(out, new RegExp(`_bucket\\{${base},le="1"\\} 2\\n`));
  assert.match(out, new RegExp(`_bucket\\{${base},le="\\+Inf"\\} 3\\n`));
  assert.match(out, new RegExp(`_sum\\{${base}\\} 3.55\\n`));
  assert.match(out, new RegExp(`_count\\{${base}\\} 3\\n`));
});

test('uses the OpenTelemetry metric and label names', () => {
  const m = createMetrics();
  m.observe(labels, 0.01);
  const out = m.render();
  assert.match(out, /# TYPE http_server_request_duration_seconds histogram/);
  assert.match(out, /http_request_method="GET"/);
  assert.match(out, /http_route="\/api\/workout\/:date"/);
  assert.match(out, /http_response_status_code="200"/);
  assert.equal(DEFAULT_BUCKETS[0], 0.005);
  assert.equal(DEFAULT_BUCKETS.at(-1), 10);
});

test('label values are escaped', () => {
  const m = createMetrics();
  m.observe({ method: 'GET', route: 'a"b\\c\nd', status: 404 }, 0.01);
  assert.match(m.render(), /http_route="a\\"b\\\\c\\nd"/);
});

test('separate series per method, route and status', () => {
  const m = createMetrics();
  m.observe(labels, 0.01);
  m.observe({ ...labels, status: 500 }, 0.01);
  m.observe({ ...labels, method: 'PUT' }, 0.01);
  assert.equal((m.render().match(/_count\{/g) || []).length, 3);
});

test('routeLabel uses the route pattern, never the raw path', () => {
  assert.equal(routeLabel({ baseUrl: '/api/workout', route: { path: '/:date' } }), '/api/workout/:date');
  assert.equal(routeLabel({ baseUrl: '/api/exercises', route: { path: '/' } }), '/api/exercises');
  assert.equal(routeLabel({ baseUrl: '', route: { path: '/api/health' } }), '/api/health');
  assert.equal(routeLabel({ baseUrl: '', path: '/uploads/x.png' }), 'other');
});

test('the metrics server answers GET /metrics and nothing else', async () => {
  const m = createMetrics();
  m.observe(labels, 0.02);
  const server = startMetricsServer(m, { port: 0, host: '127.0.0.1' });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /text\/plain; version=0.0.4/);
    assert.match(await ok.text(), /http_server_request_duration_seconds_count/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' })).status, 404);
  } finally {
    server.close();
  }
});

test('index.js only turns metrics on with METRICS_ENABLED=true, on a separate port', () => {
  const src = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(src, /process\.env\.METRICS_ENABLED === 'true'/);
  assert.match(src, /startMetricsServer\(appMetrics, \{ port: metricsPort \}\)/);
  assert.match(src, /process\.env\.METRICS_PORT \|\| 9464/);
});
