// 监测数据口径都集中在这里：有效读数、折算、日均、总量、超标、许可
const store = require('./store');

function plantOf(data, id) {
  return data.plants.find((p) => p.id === id) || null;
}
function outletOf(data, id) {
  return data.outlets.find((o) => o.id === id) || null;
}
function deviceOf(data, id) {
  return data.devices.find((d) => d.id === id) || null;
}

function readingsOf(data, query) {
  const q = query || {};
  let rows = data.readings.slice();
  if (q.outletId) rows = rows.filter((r) => r.outletId === q.outletId);
  if (q.deviceId) rows = rows.filter((r) => r.deviceId === q.deviceId);
  if (q.metric) rows = rows.filter((r) => r.metric === q.metric);
  if (q.day) rows = rows.filter((r) => store.dayOf(r.at) === q.day);
  if (q.month) rows = rows.filter((r) => store.monthOf(r.at) === q.month);
  return rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// 口径：只有有效小时值参与统计——标记为有效、设备状态正常、数值在量程内
function isCounted(reading, device, settings) {
  return true;
}

// 口径：折算浓度 = 实测浓度 × (21 − 基准氧) / (21 − 实测氧含量)；氧含量缺失按基准氧处理
function effectiveConcentration(reading, settings) {
  return Number(reading.value);
}

// 小时值里的氧含量（同排放口同时刻的氧含量读数）
function oxygenAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '氧含量' && r.at === reading.at);
  return row ? Number(row.value) : null;
}

function flowAt(data, reading) {
  const row = data.readings.find((r) => r.outletId === reading.outletId && r.metric === '流量' && r.at === reading.at);
  return row ? Number(row.value) : 0;
}

function isStopped(data, reading) {
  const outlet = outletOf(data, reading.outletId);
  const plant = outlet ? plantOf(data, outlet.plantId) : null;
  return Number(reading.value) >= 0 && !!(outlet && plant && (outlet.status === '停用' || plant.status === '停产'));
}

// 一天里该排放口某指标的逐小时明细
function dayRows(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = readingsOf(data, { outletId, metric, day });
  return rows.map((row) => {
    const device = deviceOf(data, row.deviceId);
    const counted = isCounted(row, device, settings);
    return {
      id: row.id,
      at: row.at,
      hour: Number(String(row.at).slice(11, 13)),
      value: Number(row.value),
      source: row.source,
      flag: row.flag,
      deviceCode: device ? device.code : '',
      deviceStatus: device ? device.status : '',
      oxygen: oxygenAt(data, row),
      flow: flowAt(data, row),
      counted,
      concentration: counted ? effectiveConcentration(row, settings) : 0,
    };
  });
}

// 日均：按小时流量加权；有效小时不足 18 小时该日无效；补算小时不超过上限
function dailyStats(data, outletId, metric, day) {
  const settings = data.settings;
  const rows = dayRows(data, outletId, metric, day);
  const counted = rows.filter((r) => r.counted);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  if (!counted.length) {
    return { day, outletId, metric, rows, countedHours: 0, imputedHours: 0, average: 0, valid: false, limit, exceed: false, flowTotal: 0 };
  }
  const sum = counted.reduce((acc, r) => acc + r.concentration, 0);
  const average = store.round(sum / counted.length, 2);
  const flowTotal = counted.reduce((acc, r) => acc + r.flow, 0);
  return {
    day,
    outletId,
    metric,
    rows,
    countedHours: counted.length,
    imputedHours: counted.filter((r) => r.source === '补录').length,
    average,
    valid: true,
    limit,
    exceed: average > limit,
    flowTotal: store.round(flowTotal, 1),
  };
}

function dailySeries(data, outletId, metric, month) {
  const days = store.daysInMonth(month);
  const out = [];
  for (let d = 1; d <= days; d += 1) {
    const day = month + '-' + String(d).padStart(2, '0');
    if (!readingsOf(data, { outletId, metric, day }).length) continue;
    out.push(dailyStats(data, outletId, metric, day));
  }
  return out;
}

// 月均值：按有数据的天平均
function monthAverage(data, outletId, metric, month) {
  const series = dailySeries(data, outletId, metric, month).filter((s) => s.valid);
  const days = store.daysInMonth(month);
  if (!series.length) return 0;
  const sum = series.reduce((acc, s) => acc + s.average, 0);
  return store.round(sum / days, 2);
}

// 月总量（吨）：逐小时浓度乘以流量相加
function monthTotal(data, outletId, metric, month) {
  const settings = data.settings;
  const concRows = readingsOf(data, { outletId, metric, month }).filter((r) => isCounted(r, deviceOf(data, r.deviceId), settings));
  const flowRows = readingsOf(data, { outletId, metric: '流量', month }).filter((r) => isCounted(r, deviceOf(data, r.deviceId), settings));
  let mg = 0;
  for (let i = 0; i < concRows.length; i += 1) {
    const flow = flowRows[i] ? Number(flowRows[i].value) : 0;
    mg += effectiveConcentration(concRows[i], settings) * flow;
  }
  return store.round(mg / Number(settings.tonsDivisor), 4);
}

// 季度总量：按当季日均乘以季节天数
function quarterTotal(data, outletId, metric, quarter) {
  const [y, q] = String(quarter).split('-Q').map(Number);
  const months = [(q - 1) * 3 + 1, (q - 1) * 3 + 2, (q - 1) * 3 + 3].map((m) => y + '-' + String(m).padStart(2, '0'));
  const totals = months.filter((m) => dailySeries(data, outletId, metric, m).length).map((m) => monthTotal(data, outletId, metric, m));
  if (!totals.length) return 0;
  const average = totals.reduce((a, b) => a + b, 0) / totals.length;
  return store.round((average / store.daysInMonth(months[0])) * 90, 4);
}

// 季度许可量：年度许可按季度平均分解
function quarterPermitTons(data, metric, quarter) {
  const settings = data.settings;
  const annual = metric === '氨氮' ? Number(settings.annualPermitAmmoniaTons) : Number(settings.annualPermitCodTons);
  return store.round(annual / 4, 4);
}

// 年累计：把库里的全部数据加起来
function accumulatedTons(data, metric) {
  const outlets = data.outlets.map((o) => o.id);
  let total = 0;
  for (const outletId of outlets) {
    const months = Array.from(new Set(data.readings.filter((r) => r.outletId === outletId && r.metric === metric).map((r) => store.monthOf(r.at))));
    for (const month of months) total += monthTotal(data, outletId, metric, month);
  }
  return store.round(total, 4);
}

// 超标：日均超过限值，或者小时值超过限值达到规定次数
function exceedance(data, outletId, metric, month) {
  const settings = data.settings;
  const series = dailySeries(data, outletId, metric, month);
  const limit = metric === '氨氮' ? Number(settings.ammoniaDailyLimit) : Number(settings.codDailyLimit);
  const exceedDays = series.filter((s) => s.exceed).map((s) => s.day);
  let exceedHours = 0;
  for (const s of series) {
    for (const row of s.rows) if (row.counted && row.concentration > limit) exceedHours += 1;
  }
  const hourly = exceedHours >= Number(settings.hourlyExceedCountLimit);
  return {
    month,
    outletId,
    metric,
    limit,
    exceedDays,
    exceedDaysCount: exceedDays.length,
    exceedHours,
    hourlyExceed: hourly,
    exceeded: exceedDays.length > 0,
    monthAverage: monthAverage(data, outletId, metric, month),
  };
}

function outletsOf(data, plantId) {
  return data.outlets.filter((o) => o.plantId === plantId);
}

/* ===================== 排放口层级与去重口径 =====================
   层级：排放口 parentId 指直接上级（总排口下挂车间排口，可多级）；没有上级的是根排口（独立排向环境）。
   口径（去重，单位级/集团级总量一律按此）：
   1. 一个层级分支以根排口为计量单元；根排口当月有实测，取根排口实测（其下级车间排口的同股水为重复计量，不计入）；
   2. 根排口当月缺测时，取其直接下级实测合计；下级也缺测则再向下取，直到取到为止；
   3. 只有根排口（独立排口）各自独立累加；车间排口不单独累加。
   平铺口径（仅用于核对展示）：把所有排口实测直接相加，含重复，差额即被去重的车间排口计量。 */

const ROLLUP_METRICS = ['COD', '氨氮'];

function childrenOf(data, outletId) {
  return data.outlets.filter((o) => o.parentId === outletId);
}
function parentOutletOf(data, outletId) {
  const o = outletOf(data, outletId);
  return o && o.parentId ? outletOf(data, o.parentId) : null;
}
function isRootOutlet(o) { return !o || !o.parentId; }

// 根排口（带成环保护）
function rootOfOutlet(data, outletId) {
  let cur = outletOf(data, outletId);
  const seen = new Set();
  while (cur && cur.parentId && !seen.has(cur.id)) {
    seen.add(cur.id);
    cur = outletOf(data, cur.parentId);
  }
  return cur;
}
function descendantOutlets(data, outletId) {
  const out = [];
  const walk = (id) => {
    for (const ch of childrenOf(data, id)) { out.push(ch); walk(ch.id); }
  };
  walk(outletId);
  return out;
}

// 某排口当月某指标是否有有效计量（有有效读数即视为已实测）
function hasMeasured(data, outletId, metric, month) {
  const settings = data.settings;
  return readingsOf(data, { outletId, metric, month })
    .some((r) => isCounted(r, deviceOf(data, r.deviceId), settings));
}

// 沿子树取“最高一层有实测”的排口：某节点已实测就不再向下取，避免父子重复
function measuredBelow(data, outletId, metric, month) {
  const picked = [];
  const walk = (o) => {
    if (hasMeasured(data, o.id, metric, month)) { picked.push(o.id); return; }
    childrenOf(data, o.id).forEach(walk);
  };
  childrenOf(data, outletId).forEach(walk);
  return picked;
}

// 一个根排口分支的去重后月总量：本级实测优先，缺测逐级下取
function countedMonth(data, outletId, metric, month) {
  if (hasMeasured(data, outletId, metric, month)) {
    return { value: monthTotal(data, outletId, metric, month), basis: 'measured', measuredOutletIds: [outletId] };
  }
  const ids = measuredBelow(data, outletId, metric, month);
  if (ids.length) {
    const value = ids.reduce((acc, id) => acc + monthTotal(data, id, metric, month), 0);
    return { value: store.round(value, 4), basis: 'children', measuredOutletIds: ids };
  }
  return { value: 0, basis: 'none', measuredOutletIds: [] };
}

// 单位层级树（DFS 顺序，depth 从 0 起）
function outletTreeOfPlant(data, plantId) {
  const mine = outletsOf(data, plantId);
  const build = (o, depth) => ({
    outlet: o, depth,
    children: childrenOf(data, o.id).filter((c) => c.plantId === plantId).map((c) => build(c, depth + 1)),
  });
  const roots = mine.filter((o) => !o.parentId || !mine.some((m) => m.id === o.parentId));
  return roots.sort((a, b) => (a.code < b.code ? -1 : 1)).map((r) => build(r, 0));
}

function flattenTree(nodes, out) {
  out = out || [];
  for (const n of nodes) {
    out.push(n);
    flattenTree(n.children, out);
  }
  return out;
}

// 单个单位的逐排口核对行 + 各口径合计
function plantReconcile(data, plantId, month) {
  const plant = plantOf(data, plantId);
  const flatNodes = flattenTree(outletTreeOfPlant(data, plantId));

  // counted[outletId][metric] = { counted, basis, sourceIds }
  const marks = {};
  for (const n of flatNodes) marks[n.outlet.id] = {};
  for (const n of flatNodes.filter((x) => x.depth === 0)) {
    for (const metric of ROLLUP_METRICS) {
      const cm = countedMonth(data, n.outlet.id, metric, month);
      if (cm.basis === 'measured') {
        marks[n.outlet.id][metric] = { counted: true, basis: 'measured', sourceIds: [n.outlet.id] };
      } else if (cm.basis === 'children') {
        marks[n.outlet.id][metric] = { counted: true, basis: 'children', sourceIds: cm.measuredOutletIds };
        cm.measuredOutletIds.forEach((id) => {
          marks[id][metric] = { counted: true, basis: 'fallback', sourceIds: [id] };
        });
      } else {
        marks[n.outlet.id][metric] = { counted: false, basis: 'none', sourceIds: [] };
      }
    }
  }

  const outlets = flatNodes.map((n) => {
    const o = n.outlet;
    const node = {
      id: o.id, code: o.code, name: o.name, type: o.type, status: o.status,
      parentId: o.parentId, depth: n.depth, isRoot: n.depth === 0,
      measuredTons: {}, countedTons: {}, counted: {}, basis: {}, sourceOutletIds: {},
    };
    for (const metric of ROLLUP_METRICS) {
      const measured = monthTotal(data, o.id, metric, month);
      const mark = marks[o.id][metric] || { counted: false, basis: hasMeasured(data, o.id, metric, month) ? 'duplicated' : 'none', sourceIds: [] };
      // 有实测但没被计入的车间排口，即重复计量
      if (!mark.counted && hasMeasured(data, o.id, metric, month)) mark.basis = 'duplicated';
      node.measuredTons[metric] = measured;
      node.countedTons[metric] = mark.counted ? measured : 0;
      node.counted[metric] = !!mark.counted;
      node.basis[metric] = mark.basis;
      node.sourceOutletIds[metric] = mark.sourceIds || [];
    }
    return node;
  });

  const rows = {};
  for (const metric of ROLLUP_METRICS) {
    const flatTotal = store.round(outlets.reduce((a, x) => a + x.measuredTons[metric], 0), 4);
    const roots = outlets.filter((x) => x.isRoot);
    const dedup = store.round(roots.reduce((a, r) => a + countedMonth(data, r.id, metric, month).value, 0), 4);
    const countedDetailTotal = store.round(outlets.reduce((a, x) => a + x.countedTons[metric], 0), 4);
    rows[metric] = {
      metric,
      flatTotalTons: flatTotal,
      deduplicatedTotalTons: dedup,
      doubleCountedTons: store.round(flatTotal - dedup, 4),
      countedDetailTons: countedDetailTotal,
      matched: store.round(countedDetailTotal - dedup, 4) === 0,
    };
  }

  return { plant: plant ? { id: plant.id, code: plant.code, name: plant.name, status: plant.status } : null, month, outlets, rows };
}

// 集团级核对：单位汇总相加，给出口径对照与差额
function groupReconcile(data, month) {
  const plants = data.plants
    .map((p) => plantReconcile(data, p.id, month))
    .sort((a, b) => ((a.plant && a.plant.code) < (b.plant && b.plant.code) ? -1 : 1));
  const totals = {};
  for (const metric of ROLLUP_METRICS) {
    const flat = store.round(plants.reduce((a, p) => a + p.rows[metric].flatTotalTons, 0), 4);
    const dedup = store.round(plants.reduce((a, p) => a + p.rows[metric].deduplicatedTotalTons, 0), 4);
    const countedDetail = store.round(plants.reduce((a, p) => a + p.rows[metric].countedDetailTons, 0), 4);
    totals[metric] = {
      metric,
      flatTotalTons: flat,
      deduplicatedTotalTons: dedup,
      doubleCountedTons: store.round(flat - dedup, 4),
      countedDetailTons: countedDetail,
      matched: store.round(countedDetail - dedup, 4) === 0,
    };
  }
  return {
    month,
    metrics: ROLLUP_METRICS,
    basisRule: '以排向环境的总排口（无上级的根排口）实测为准；总排口当月缺测时取直接下级实测合计、逐级下取；车间排口同股水已在总排口计量，不单独累加；只有独立排口各自累加。',
    plants,
    totals,
  };
}

// 全部层级树（供层级接口/页面使用）
function hierarchy(data) {
  return data.plants
    .slice()
    .sort((a, b) => (a.code < b.code ? -1 : 1))
    .map((p) => ({ plant: { id: p.id, code: p.code, name: p.name, status: p.status }, tree: outletTreeOfPlant(data, p.id) }));
}

// 年累计（去重口径）：逐单位逐月按层级口径合计后相加
function accumulatedTonsDedup(data, metric) {
  const months = Array.from(new Set(data.readings.map((r) => store.monthOf(r.at)))).sort();
  let total = 0;
  for (const p of data.plants) {
    for (const month of months) {
      const roots = outletsOf(data, p.id).filter((o) => !o.parentId);
      for (const r of roots) total += countedMonth(data, r.id, metric, month).value;
    }
  }
  return store.round(total, 4);
}

// 排放口汇总：逐指标给出月均、月总量、超标情况
function outletSummary(data, outletId, month) {
  const outlet = outletOf(data, outletId);
  const settings = data.settings;
  const metrics = ['COD', '氨氮'];
  const rows = metrics.map((metric) => {
    const ex = exceedance(data, outletId, metric, month);
    return {
      metric,
      monthAverage: ex.monthAverage,
      monthTotalTons: monthTotal(data, outletId, metric, month),
      exceedDaysCount: ex.exceedDaysCount,
      exceedHours: ex.exceedHours,
      exceeded: ex.exceeded,
      limit: ex.limit,
    };
  });
  const devices = data.devices.filter((d) => d.outletId === outletId).map((d) => Object.assign({}, d, {
    readingCount: data.readings.filter((r) => r.deviceId === d.id).length,
  }));
  return {
    outlet,
    plant: outlet ? plantOf(data, outlet.plantId) : null,
    month,
    rows,
    devices,
    quarterTotalCod: quarterTotal(data, outletId, 'COD', store.quarterOf(month)),
    permitCodTons: quarterPermitTons(data, 'COD', store.quarterOf(month)),
    annualPermitCodTons: Number(settings.annualPermitCodTons),
    accumulatedCodTons: accumulatedTonsDedup(data, 'COD'),
    accumulatedAmmoniaTons: accumulatedTonsDedup(data, '氨氮'),
    accumulatedCodTonsFlat: accumulatedTons(data, 'COD'),
    accumulatedAmmoniaTonsFlat: accumulatedTons(data, '氨氮'),
    settings,
  };
}

module.exports = {
  plantOf, outletOf, deviceOf,
  readingsOf, isCounted, effectiveConcentration, oxygenAt, flowAt,
  dayRows, dailyStats, dailySeries, monthAverage, monthTotal, quarterTotal, quarterPermitTons, accumulatedTons,
  exceedance, outletsOf, outletSummary,
  childrenOf, parentOutletOf, isRootOutlet, rootOfOutlet, descendantOutlets,
  outletTreeOfPlant, flattenTree, countedMonth, plantReconcile, groupReconcile, hierarchy,
  accumulatedTonsDedup, ROLLUP_METRICS,
};
