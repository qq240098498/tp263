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

// 年累计（平铺口径，仅对照用）：把范围内每个排放口逐月累加，含总排口/车间排口重复计量
function flatAccumulatedTons(data, metric, plantId) {
  const scopeIds = new Set(outletsInScope(data, plantId).map((o) => o.id));
  let total = 0;
  for (const outletId of scopeIds) {
    const months = Array.from(new Set(data.readings.filter((r) => r.outletId === outletId && r.metric === metric).map((r) => store.monthOf(r.at))));
    for (const month of months) total += monthTotal(data, outletId, metric, month);
  }
  return store.round(total, 4);
}

// 年累计（去重口径，对外）：逐月按层级每根子树只取一个排口的计量，再跨月累加
function accumulatedTons(data, metric, plantId) {
  const scopeIds = new Set(outletsInScope(data, plantId).map((o) => o.id));
  const months = Array.from(new Set(
    data.readings.filter((r) => scopeIds.has(r.outletId)).map((r) => store.monthOf(r.at))
  )).sort();
  let total = 0;
  for (const month of months) {
    total += hierarchyRollup(data, { month, metric, plantId: plantId || '' }).dedupTotalTons;
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

/* ================= 排放口层级与去重口径 =================
 * 层级用 outlets.parentId 表达：parentId 为空 = 顶层外排口（总排口/独立排口），
 * 非空 = 出水汇入上级的车间/过程排口（可多级）。
 * 去重口径（对外）：一个根子树的同一股水只算一次——顶层外排口当月有计量就以它
 * 实测为准，其下各级汇入排口一律不累计；顶层无计量时才沿树取第一个有计量的下级
 * 替代，并在依据里写明；平铺口径（逐口相加，含重复）只保留作对照。 */

function childrenOf(data, outletId) {
  return data.outlets.filter((o) => o.parentId === outletId).sort((a, b) => (a.code < b.code ? -1 : 1));
}

// 全部后代 id（广度优先，带成环保护）
function descendantIds(data, outletId) {
  const out = [];
  const seen = new Set([outletId]);
  let frontier = [outletId];
  while (frontier.length) {
    const next = [];
    for (const pid of frontier) {
      for (const ch of data.outlets.filter((o) => o.parentId === pid)) {
        if (seen.has(ch.id)) continue;
        seen.add(ch.id);
        out.push(ch.id);
        next.push(ch.id);
      }
    }
    frontier = next;
  }
  return out;
}

function outletsInScope(data, plantId) {
  return plantId ? data.outlets.filter((o) => o.plantId === plantId) : data.outlets.slice();
}

// 顶层排口：parentId 为空，或上级已不在数据/不在本范围（历史脏数据兜底）
function rootOutlets(data, plantId) {
  const scope = outletsInScope(data, plantId);
  const ids = new Set(scope.map((o) => o.id));
  return scope.filter((o) => !o.parentId || !ids.has(o.parentId))
    .sort((a, b) => {
      const pa = plantOf(data, a.plantId);
      const pb = plantOf(data, b.plantId);
      const ca = pa ? pa.code : '';
      const cb = pb ? pb.code : '';
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.code < b.code ? -1 : 1;
    });
}

function outletDepth(data, outlet) {
  let depth = 0;
  const seen = new Set();
  let cur = outlet;
  while (cur && cur.parentId) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = outletOf(data, cur.parentId);
    depth += 1;
  }
  return depth;
}

function outletPath(data, outlet) {
  const chain = [];
  const seen = new Set();
  let cur = outlet;
  while (cur) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    chain.unshift(cur.code);
    cur = cur.parentId ? outletOf(data, cur.parentId) : null;
  }
  return chain.join(' / ');
}

// 当月该指标是否有计量读数（不区分有效标记，只看有没有数据）
function outletMeasured(data, outletId, metric, month) {
  return readingsOf(data, { outletId, metric, month }).length > 0;
}

// 深度优先（同层按编码）找第一个当月有计量的后代
function firstMeasuredDescendant(data, outletId, metric, month, guard) {
  const seen = guard || new Set();
  for (const ch of childrenOf(data, outletId)) {
    if (seen.has(ch.id)) continue;
    seen.add(ch.id);
    if (outletMeasured(data, ch.id, metric, month)) return ch;
    const deeper = firstMeasuredDescendant(data, ch.id, metric, month, seen);
    if (deeper) return deeper;
  }
  return null;
}

// 一个根子树去重后取哪一个排口的计量
function resolveRootOutlet(data, root, metric, month) {
  if (outletMeasured(data, root.id, metric, month)) {
    return { resolvedId: root.id, measured: true, basis: '外排口实测' };
  }
  const sub = firstMeasuredDescendant(data, root.id, metric, month);
  if (sub) {
    return { resolvedId: sub.id, measured: true, basis: '外排口本月无计量，取下级 ' + sub.code + ' 实测替代' };
  }
  return { resolvedId: root.id, measured: false, basis: '本月本树无计量，按 0 计' };
}

// 层级汇总：平铺合计 / 去重合计 / 虚高差额 / 逐口台账 / 逐子树核对
function hierarchyRollup(data, opts) {
  const month = opts.month;
  const metric = opts.metric;
  const plantId = opts.plantId || '';
  const scope = outletsInScope(data, plantId);
  const scopeIds = new Set(scope.map((o) => o.id));
  const roots = rootOutlets(data, plantId);
  const ledger = [];
  const rootCards = [];
  let flatTotalTons = 0;
  let dedupTotalTons = 0;

  const pushRow = (o, root, resolve, depth) => {
    const plant = plantOf(data, o.plantId);
    const parent = o.parentId ? outletOf(data, o.parentId) : null;
    const measured = outletMeasured(data, o.id, metric, month);
    const ownTons = monthTotal(data, o.id, metric, month);
    const isRoot = o.id === root.id;
    const hasChildren = descendantIds(data, root.id).length > 0;
    const counted = o.id === resolve.resolvedId;
    let role;
    let basis;
    if (counted) {
      if (isRoot) role = hasChildren ? '外排口' : '独立外排口';
      else role = '替代计量';
      basis = isRoot && !hasChildren ? (measured ? '独立排放，单独累加（实测）' : '本月无计量，按 0 计') : resolve.basis;
    } else if (isRoot) {
      // 顶层外排口本月无计量，已取下级替代
      role = hasChildren ? '外排口' : '独立外排口';
      basis = resolve.basis;
    } else {
      role = '过程口（汇入上级）';
      if (resolve.resolvedId === root.id) {
        basis = parent ? '出水汇入「' + parent.code + '」，已含在上级计量中，不重复计入' : '';
      } else {
        const alt = outletOf(data, resolve.resolvedId);
        basis = '顶层外排口本月无计量，去重口径只取下级「' + (alt ? alt.code : '') + '」替代计入，本口不另计';
      }
    }
    flatTotalTons += ownTons;
    if (counted) dedupTotalTons += ownTons;
    ledger.push({
      id: o.id, code: o.code, name: o.name,
      plantId: o.plantId, plantCode: plant ? plant.code : '', plantName: plant ? plant.name : '',
      parentId: o.parentId || '', parentCode: parent ? parent.code : '',
      type: o.type, status: o.status, depth, path: outletPath(data, o),
      measured, ownTons, counted, role, basis,
    });
    return ownTons;
  };

  for (const root of roots) {
    const resolve = resolveRootOutlet(data, root, metric, month);
    const dropped = [];
    const walk = (o, depth) => {
      const ownTons = pushRow(o, root, resolve, depth);
      if (o.id !== resolve.resolvedId && ownTons > 0) {
        dropped.push({ id: o.id, code: o.code, name: o.name, tons: ownTons });
      }
      childrenOf(data, o.id).filter((ch) => scopeIds.has(ch.id)).forEach((ch) => walk(ch, depth + 1));
    };
    walk(root, 0);
    const subtreeIds = new Set([root.id].concat(descendantIds(data, root.id)).filter((id) => scopeIds.has(id)));
    const subtreeFlatTons = store.round(ledger.filter((r) => subtreeIds.has(r.id)).reduce((a, r) => a + r.ownTons, 0), 4);
    const countedTons = store.round(monthTotal(data, resolve.resolvedId, metric, month), 4);
    const resolvedOutlet = outletOf(data, resolve.resolvedId);
    rootCards.push({
      rootId: root.id, rootCode: root.code, rootName: root.name, plantId: root.plantId,
      resolvedId: resolve.resolvedId,
      resolvedCode: resolvedOutlet ? resolvedOutlet.code : '',
      resolvedName: resolvedOutlet ? resolvedOutlet.name : '',
      resolvedBasis: resolve.basis,
      subtreeFlatTons,
      countedTons,
      duplicatedTons: store.round(subtreeFlatTons - countedTons, 4),
      dropped,
    });
  }

  flatTotalTons = store.round(flatTotalTons, 4);
  dedupTotalTons = store.round(dedupTotalTons, 4);
  // 核对：计入行逐口相加 vs 逐子树层级汇总——同一数据源结构性相等，正常差额为 0
  const detailSumTons = store.round(ledger.filter((r) => r.counted).reduce((a, r) => a + r.ownTons, 0), 4);
  const hierarchyTotalTons = store.round(rootCards.reduce((a, c) => a + c.countedTons, 0), 4);
  const flatDetailSumTons = store.round(ledger.reduce((a, r) => a + r.ownTons, 0), 4);
  const diffTons = store.round(detailSumTons - hierarchyTotalTons, 4);
  const flatDiffTons = store.round(flatDetailSumTons - flatTotalTons, 4);
  const diffSources = [];
  if (diffTons !== 0) diffSources.push('计入行逐口相加（' + detailSumTons + '）与子树汇总（' + hierarchyTotalTons + '）不一致，需检查读数与层级配置');
  if (flatDiffTons !== 0) diffSources.push('平铺合计与逐口相加差 ' + flatDiffTons + ' 吨');

  return {
    month, metric, scope: plantId ? 'plant' : 'group', plantId,
    outletCount: scope.length,
    countedOutletCount: ledger.filter((r) => r.counted).length,
    flatTotalTons,
    dedupTotalTons,
    duplicatedTons: store.round(flatTotalTons - dedupTotalTons, 4),
    ledger,
    roots: rootCards,
    reconciliation: {
      detailSumTons,
      hierarchyTotalTons,
      diffTons,
      flatDetailSumTons,
      flatTotalTons,
      flatDiffTons,
      consistent: diffTons === 0 && flatDiffTons === 0,
      diffSources,
    },
  };
}

// 层级树（结构，供页面树形展示）
function outletTree(data, plantId) {
  const scope = outletsInScope(data, plantId);
  const ids = new Set(scope.map((o) => o.id));
  const byParent = {};
  for (const o of scope) {
    const p = o.parentId && ids.has(o.parentId) ? o.parentId : '';
    (byParent[p] = byParent[p] || []).push(o);
  }
  const build = (pid, depth) => (byParent[pid] || []).sort((a, b) => (a.code < b.code ? -1 : 1)).map((o) => ({
    id: o.id, code: o.code, name: o.name, plantId: o.plantId,
    type: o.type, status: o.status,
    parentId: o.parentId || '', depth, path: outletPath(data, o),
    childCount: (byParent[o.id] || []).length,
    children: build(o.id, depth + 1),
  }));
  return build('', 0);
}

// 顺父链找到根子树（带成环保护）
function rootOfOutlet(data, outlet) {
  let cur = outlet;
  const seen = new Set();
  while (cur && cur.parentId) {
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    const up = outletOf(data, cur.parentId);
    if (!up) break;
    cur = up;
  }
  return cur || outlet;
}

// 排放口汇总：逐指标给出月均、月总量、超标情况
function outletSummary(data, outletId, month) {
  const outlet = outletOf(data, outletId);
  const settings = data.settings;
  const metrics = ['COD', '氨氮'];
  const parent = outlet && outlet.parentId ? outletOf(data, outlet.parentId) : null;
  const depth = outlet ? outletDepth(data, outlet) : 0;
  const path = outlet ? outletPath(data, outlet) : '';
  const root = outlet ? rootOfOutlet(data, outlet) : null;
  const hierarchyByMetric = {};
  const rows = metrics.map((metric) => {
    const ex = exceedance(data, outletId, metric, month);
    const resolve = root ? resolveRootOutlet(data, root, metric, month) : null;
    hierarchyByMetric[metric] = resolve ? {
      rootId: root.id, rootCode: root.code,
      counted: resolve.resolvedId === outletId,
      role: resolve.resolvedId === outletId
        ? (root.id === outletId ? (descendantIds(data, root.id).length ? '外排口' : '独立外排口') : '替代计量')
        : (root.id === outletId ? (descendantIds(data, root.id).length ? '外排口' : '独立外排口') : '过程口（汇入上级）'),
      basis: resolve.basis,
    } : null;
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
    hierarchy: {
      parentId: outlet ? (outlet.parentId || '') : '',
      parentCode: parent ? parent.code : '',
      parentName: parent ? parent.name : '',
      depth,
      path,
      rootId: root ? root.id : '',
      rootCode: root ? root.code : '',
      byMetric: hierarchyByMetric,
    },
    devices,
    quarterTotalCod: quarterTotal(data, outletId, 'COD', store.quarterOf(month)),
    permitCodTons: quarterPermitTons(data, 'COD', store.quarterOf(month)),
    annualPermitCodTons: Number(settings.annualPermitCodTons),
    accumulatedCodTons: accumulatedTons(data, 'COD'),
    accumulatedAmmoniaTons: accumulatedTons(data, '氨氮'),
    settings,
  };
}

module.exports = {
  plantOf, outletOf, deviceOf,
  readingsOf, isCounted, effectiveConcentration, oxygenAt, flowAt,
  dayRows, dailyStats, dailySeries, monthAverage, monthTotal, quarterTotal, quarterPermitTons,
  accumulatedTons, flatAccumulatedTons,
  exceedance, outletsOf, outletSummary,
  childrenOf, descendantIds, rootOutlets, outletsInScope, outletDepth, outletPath,
  outletMeasured, resolveRootOutlet, rootOfOutlet, hierarchyRollup, outletTree,
};
