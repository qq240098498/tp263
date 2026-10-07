const express = require('express');
const store = require('./store');
const { AppError } = require('./errors');
const res = require('./resources');
const monitor = require('./monitor');

const router = express.Router();

function withData(handler) {
  return (req, reqRes, next) => {
    try {
      const data = store.load();
      const result = handler(data, req);
      if (result && result.__save === true) store.save(data);
      if (result && typeof result === 'object' && '__body' in result) reqRes.json(result.__body);
      else reqRes.json(result);
    } catch (err) {
      next(err);
    }
  };
}

function currentMonth(data) {
  const months = Array.from(new Set(data.readings.map((r) => store.monthOf(r.at)))).sort();
  return months.length ? months[months.length - 1] : store.nowText().slice(0, 7);
}

function overview(data) {
  const settings = data.settings;
  const month = currentMonth(data);
  const outletRows = data.outlets.map((o) => monitor.outletSummary(data, o.id, month));
  const statusCount = {};
  for (const p of data.plants) statusCount[p.status] = (statusCount[p.status] || 0) + 1;
  const deviceStatus = {};
  for (const d of data.devices) deviceStatus[d.status] = (deviceStatus[d.status] || 0) + 1;
  return {
    today: store.nowText().slice(0, 10),
    month,
    plantCount: data.plants.length,
    producingCount: data.plants.filter((p) => p.status === '生产').length,
    outletCount: data.outlets.length,
    runningOutletCount: data.outlets.filter((o) => o.status === '运行').length,
    deviceCount: data.devices.length,
    deviceStatus,
    readingCount: data.readings.length,
    autoCount: data.readings.filter((r) => r.source === '自动').length,
    imputedCount: data.readings.filter((r) => r.source === '补录').length,
    invalidFlagCount: data.readings.filter((r) => r.flag !== '有效').length,
    reportCount: data.reports.length,
    submittedReportCount: data.reports.filter((r) => r.status === '已上报').length,
    exceededOutletCount: outletRows.filter((s) => s.rows.some(
      (r) => r.exceeded && s.hierarchy.byMetric[r.metric] && s.hierarchy.byMetric[r.metric].counted
    )).length,
    accumulatedCodTons: monitor.accumulatedTons(data, 'COD'),
    accumulatedAmmoniaTons: monitor.accumulatedTons(data, '氨氮'),
    flatAccumulatedCodTons: monitor.flatAccumulatedTons(data, 'COD'),
    flatAccumulatedAmmoniaTons: monitor.flatAccumulatedTons(data, '氨氮'),
    permitCodTons: Number(settings.annualPermitCodTons),
    permitAmmoniaTons: Number(settings.annualPermitAmmoniaTons),
    settings: {
      oxygenBaseline: Number(settings.oxygenBaseline),
      rangeMax: Number(settings.rangeMax),
      maxImputeHoursPerDay: Number(settings.maxImputeHoursPerDay),
      codDailyLimit: Number(settings.codDailyLimit),
      ammoniaDailyLimit: Number(settings.ammoniaDailyLimit),
      hourlyExceedCountLimit: Number(settings.hourlyExceedCountLimit),
      annualPermitCodTons: Number(settings.annualPermitCodTons),
      annualPermitAmmoniaTons: Number(settings.annualPermitAmmoniaTons),
      tonsDivisor: Number(settings.tonsDivisor),
    },
    outlets: outletRows.map((s) => ({
      id: s.outlet.id,
      code: s.outlet.code,
      name: s.outlet.name,
      status: s.outlet.status,
      type: s.outlet.type,
      plantCode: s.plant ? s.plant.code : '',
      plantName: s.plant ? s.plant.name : '',
      parentId: s.hierarchy.parentId,
      parentCode: s.hierarchy.parentCode,
      depth: s.hierarchy.depth,
      path: s.hierarchy.path,
      roleByMetric: { COD: s.hierarchy.byMetric.COD && s.hierarchy.byMetric.COD.role, 氨氮: s.hierarchy.byMetric['氨氮'] && s.hierarchy.byMetric['氨氮'].role },
      countedByMetric: { COD: !!(s.hierarchy.byMetric.COD && s.hierarchy.byMetric.COD.counted), 氨氮: !!(s.hierarchy.byMetric['氨氮'] && s.hierarchy.byMetric['氨氮'].counted) },
      basisByMetric: { COD: s.hierarchy.byMetric.COD && s.hierarchy.byMetric.COD.basis, 氨氮: s.hierarchy.byMetric['氨氮'] && s.hierarchy.byMetric['氨氮'].basis },
      deviceCount: s.devices.length,
      rows: s.rows,
      accumulatedCodTons: s.accumulatedCodTons,
      quarterTotalCod: s.quarterTotalCod,
      permitCodTons: s.permitCodTons,
    })),
  };
}

router.get('/health', (req, r) => r.json({ ok: true, service: '污染源在线监测与排污总量核算台', time: new Date().toISOString() }));
router.get('/summary', withData((data) => overview(data)));
router.get('/settings', withData((data) => data.settings));
router.patch('/settings', withData((data, req) => {
  const patch = req.body || {};
  for (const key of Object.keys(store.DEFAULT_SETTINGS)) if (patch[key] !== undefined) data.settings[key] = patch[key];
  return { __save: true, __body: data.settings };
}));

router.get('/plants', withData((data, req) => res.listPlants(data, req.query)));
router.post('/plants', withData((data, req) => ({ __save: true, __body: res.createPlant(data, req.body || {}) })));
router.get('/plants/:id', withData((data, req) => res.plantDetail(data, req.params.id)));
router.patch('/plants/:id', withData((data, req) => ({ __save: true, __body: res.updatePlant(data, req.params.id, req.body || {}) })));
router.delete('/plants/:id', withData((data, req) => ({ __save: true, __body: res.removePlant(data, req.params.id) })));

router.get('/outlets', withData((data, req) => res.listOutlets(data, req.query)));
router.post('/outlets', withData((data, req) => ({ __save: true, __body: res.createOutlet(data, req.body || {}) })));
router.patch('/outlets/:id', withData((data, req) => ({ __save: true, __body: res.updateOutlet(data, req.params.id, req.body || {}) })));
router.delete('/outlets/:id', withData((data, req) => ({ __save: true, __body: res.removeOutlet(data, req.params.id) })));
router.get('/outlets/:id/summary', withData((data, req) => monitor.outletSummary(data, req.params.id, req.query.month || currentMonth(data))));
router.get('/outlets/:id/daily', withData((data, req) => {
  const month = req.query.month || currentMonth(data);
  const metrics = req.query.metric ? [req.query.metric] : ['COD', '氨氮'];
  const out = {};
  for (const metric of metrics) out[metric] = monitor.dailySeries(data, req.params.id, metric, month);
  return { outletId: req.params.id, month, metrics: out };
}));
router.get('/outlets/:id/exceedance', withData((data, req) => {
  const month = req.query.month || currentMonth(data);
  const metrics = req.query.metric ? [req.query.metric] : ['COD', '氨氮'];
  return metrics.map((metric) => monitor.exceedance(data, req.params.id, metric, month));
}));

// 层级与一键核对：无 plantId = 集团口径，带 plantId = 单位口径；metrics 各出平铺/去重/差额/逐口台账
router.get('/hierarchy', withData((data, req) => {
  const month = req.query.month || currentMonth(data);
  const plantId = req.query.plantId || '';
  if (plantId && !data.plants.some((p) => p.id === plantId)) {
    throw new AppError(404, 'PLANT_NOT_FOUND', '这个排污单位不存在');
  }
  const metrics = {};
  for (const metric of ['COD', '氨氮']) {
    metrics[metric] = monitor.hierarchyRollup(data, { month, metric, plantId });
  }
  return {
    month,
    scope: plantId ? 'plant' : 'group',
    plantId,
    plant: plantId ? data.plants.find((p) => p.id === plantId) || null : null,
    trees: monitor.outletTree(data, plantId),
    policy: [
      '外排口（无上级的总排口/独立排口）当月有计量的，以其实测为准；',
      '出水汇入上级的车间/过程排口不累计，其计量视为已含在上级中（标「重复计入」）；',
      '外排口当月无计量时，沿层级取第一个有计量的下级排口替代，并写明依据；',
      '「平铺合计」逐口相加、含重复，仅作对照；对外数字一律用「去重合计」。',
    ],
    metrics,
  };
}));

router.get('/devices', withData((data, req) => res.listDevices(data, req.query)));
router.post('/devices', withData((data, req) => ({ __save: true, __body: res.createDevice(data, req.body || {}) })));
router.patch('/devices/:id', withData((data, req) => ({ __save: true, __body: res.updateDevice(data, req.params.id, req.body || {}) })));
router.delete('/devices/:id', withData((data, req) => ({ __save: true, __body: res.removeDevice(data, req.params.id) })));

router.get('/readings', withData((data, req) => res.listReadings(data, req.query)));
router.post('/readings', withData((data, req) => ({ __save: true, __body: res.createReading(data, req.body || {}) })));
router.patch('/readings/:id', withData((data, req) => ({ __save: true, __body: res.updateReading(data, req.params.id, req.body || {}) })));
router.delete('/readings/:id', withData((data, req) => ({ __save: true, __body: res.removeReading(data, req.params.id) })));

router.get('/reports', withData((data, req) => res.listReports(data, req.query)));
router.post('/reports', withData((data, req) => ({ __save: true, __body: res.createReport(data, req.body || {}) })));
router.get('/reports/:id', withData((data, req) => res.reportDetail(data, req.params.id)));
router.patch('/reports/:id', withData((data, req) => ({ __save: true, __body: res.updateReport(data, req.params.id, req.body || {}) })));

router.use((req, r, next) => next(new AppError(404, 'NOT_FOUND', '这个地址没有对应功能：' + req.method + ' ' + req.originalUrl)));

module.exports = router;
