/* 污染源在线监测与排污总量核算台 —— 纯原生前端
   显示纪律：除「折算后浓度（页面自算）」外，所有数字直接用接口返回值。 */
(function () {
  'use strict';

  /* ================= 常量（与后端校验口径一致） ================= */
  var METRICS = ['COD', '氨氮', '流量', '氧含量'];
  var MAIN_METRICS = ['COD', '氨氮'];
  var PLANT_STATUS = ['生产', '停产', '调试'];
  var OUTLET_STATUS = ['运行', '停用'];
  var OUTLET_TYPE = ['主要排放口', '一般排放口'];
  var DEVICE_STATUS = ['正常', '校准', '维护', '故障'];
  var FLAGS = ['有效', '无效'];
  var SOURCES = ['自动', '补录'];
  var REPORT_STATUS = ['草稿', '已上报', '退回'];

  /* ================= 全局状态 ================= */
  var state = {
    view: 'overview',
    today: '',
    month: '',
    settings: null,
    summary: null,
    plants: [],
    outlets: [],
    devices: [],
    reports: [],
    readings: { total: 0, returned: 0, rows: [] },
    plantsFilter: { status: '', keyword: '' },
    outletsFilter: { plantId: '', status: '' },
    devicesFilter: { outletId: '', metric: '', status: '' },
    readingsFilter: { outletId: '', deviceId: '', metric: '', day: '', month: '' },
    accounting: { outletId: '', month: '', metric: 'COD' }
  };

  /* ================= 基础工具 ================= */
  function appendChildren(node, list) {
    list.forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) { appendChildren(node, c); return; }
      if (typeof c === 'object' && c.nodeType) node.appendChild(c);
      else node.appendChild(document.createTextNode(String(c)));
    });
  }

  function h(tag, props) {
    var node = document.createElement(tag);
    var children = Array.prototype.slice.call(arguments, 2);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'dataset') { Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; }); }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      });
    }
    appendChildren(node, children);
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  async function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    var res = await fetch(path, opts);
    var data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      var err = (data && data.error) ? data.error : {};
      var ex = new Error(err.message || ('请求失败（HTTP ' + res.status + '）'));
      ex.code = err.code || ('HTTP_' + res.status);
      ex.details = err.details || null;
      ex.status = res.status;
      throw ex;
    }
    return data;
  }

  function qs(obj) {
    var parts = [];
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if (v !== '' && v !== null && v !== undefined) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? ('?' + parts.join('&')) : '';
  }

  function textOf(v) {
    if (v === null || v === undefined || v === '') return '—';
    return String(v);
  }
  function num(v, digits) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    if (!isFinite(n)) return null;
    var d = (digits === null || digits === undefined) ? 2 : digits;
    var f = Math.pow(10, d);
    return Math.round(n * f) / f;
  }
  function fmt(v, digits) {
    var n = num(v, digits);
    return n === null ? '—' : String(n);
  }
  function metricOf(rows, name) {
    rows = rows || [];
    for (var i = 0; i < rows.length; i++) if (rows[i].metric === name) return rows[i];
    return { metric: name };
  }

  /* 折算后浓度（页面自算）：实测 × (21 − 基准氧) / (21 − 实测氧含量)，氧含量缺失按 0 代入 */
  function pageConcentration(row) {
    var base = (state.settings && state.settings.oxygenBaseline !== null && state.settings.oxygenBaseline !== undefined)
      ? Number(state.settings.oxygenBaseline) : 8;
    var oxy = (row.oxygen === null || row.oxygen === undefined || row.oxygen === '') ? 0 : Number(row.oxygen);
    var denom = 21 - oxy;
    if (!isFinite(denom) || denom === 0) return null;
    var value = Number(row.value);
    if (!isFinite(value)) return null;
    return value * (21 - base) / denom;
  }

  /* ================= 错误提示 ================= */
  var errorBanner = document.getElementById('errorBanner');
  var errorDetails = document.getElementById('errorDetails');
  function showError(e) {
    document.getElementById('errorMessage').textContent = (e && e.message) ? e.message : '操作没成功';
    clear(errorDetails);
    var details = e ? e.details : null;
    var fields = [];
    if (details && typeof details === 'object') {
      Object.keys(details).forEach(function (k) {
        fields.push(k);
        errorDetails.appendChild(h('li', { text: k + '：' + details[k] }));
      });
      errorDetails.hidden = false;
    } else if (details) {
      errorDetails.appendChild(h('li', { text: String(details) }));
      errorDetails.hidden = false;
    } else {
      errorDetails.hidden = true;
    }
    fields.forEach(function (k) {
      var input = document.querySelector('[data-field="' + k + '"]');
      if (input) input.classList.add('is-invalid');
    });
    errorBanner.hidden = false;
  }
  function clearError() {
    errorBanner.hidden = true;
    document.querySelectorAll('.is-invalid').forEach(function (n) { n.classList.remove('is-invalid'); });
  }
  document.getElementById('errorClose').addEventListener('click', clearError);

  /* ================= 轻提示 ================= */
  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2400);
  }

  /* ================= 弹层 ================= */
  var modalMask = document.getElementById('modalMask');
  function openModal(title, bodyNode, footNodes) {
    document.getElementById('modalTitle').textContent = title;
    clear(document.getElementById('modalBody')).appendChild(bodyNode);
    var foot = clear(document.getElementById('modalFoot'));
    (footNodes || []).forEach(function (n) { foot.appendChild(n); });
    modalMask.hidden = false;
  }
  function closeModal() { modalMask.hidden = true; }
  document.getElementById('modalClose').addEventListener('click', closeModal);
  modalMask.addEventListener('click', function (e) { if (e.target === modalMask) closeModal(); });

  function formField(field, value) {
    var wrap = h('div', { class: 'field' + (field.full ? ' full' : '') });
    wrap.appendChild(h('label', { text: field.label }));
    var input;
    if (field.type === 'select') {
      input = h('select', { dataset: { field: field.name } });
      (field.options || []).forEach(function (opt) {
        var val = (typeof opt === 'object') ? opt.value : opt;
        var lab = (typeof opt === 'object') ? opt.label : opt;
        input.appendChild(h('option', { value: val, text: lab }));
      });
      input.value = (value === null || value === undefined) ? '' : String(value);
    } else {
      input = h('input', { type: field.type || 'text', dataset: { field: field.name } });
      input.value = (value === null || value === undefined) ? '' : String(value);
    }
    wrap.appendChild(input);
    return wrap;
  }
  function buildForm(fields, values) {
    values = values || {};
    var grid = h('div', { class: 'form-grid' });
    fields.forEach(function (f) { grid.appendChild(formField(f, values[f.name])); });
    return grid;
  }
  function collectForm(root) {
    var out = {};
    root.querySelectorAll('[data-field]').forEach(function (n) { out[n.dataset.field] = n.value; });
    return out;
  }

  /* ================= 按钮 / 行 ================= */
  function actionBtn(label, fn, cls) {
    return h('button', {
      type: 'button',
      class: 'btn btn-sm ' + (cls || 'btn-ghost'),
      text: label,
      onclick: function (ev) { ev.stopPropagation(); fn(ev); }
    });
  }

  function deleteBtn(label, run) {
    var btn = h('button', { type: 'button', class: 'btn btn-sm btn-danger', text: label });
    var armed = false;
    var timer = null;
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (!armed) {
        armed = true;
        btn.textContent = '确认删除';
        timer = setTimeout(function () { armed = false; btn.textContent = label; }, 4000);
        return;
      }
      clearTimeout(timer);
      armed = false;
      btn.disabled = true;
      btn.textContent = '删除中…';
      Promise.resolve().then(run).catch(function (e) {
        btn.disabled = false;
        btn.textContent = label;
        showError(e);
      });
    });
    return btn;
  }

  function actionsCell(buttons) {
    var box = h('div', { class: 'inline-actions' });
    buttons.forEach(function (b) { box.appendChild(b); });
    return h('td', { class: 'nowrap' }, box);
  }

  function expandableRow(cells, detailFactory) {
    var tr = h('tr', { class: 'row' }, cells);
    var detailTr = null;
    tr.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest('.inline-actions')) return;
      if (detailTr) {
        var willShow = detailTr.hidden;
        detailTr.hidden = !willShow;
        tr.classList.toggle('is-open', willShow);
        return;
      }
      var td = h('td', { colspan: String(cells.length) }, h('span', { class: 'empty', text: '加载中…' }));
      detailTr = h('tr', { class: 'expand-row' }, td);
      tr.classList.add('is-open');
      tr.parentNode.insertBefore(detailTr, tr.nextSibling);
      Promise.resolve().then(detailFactory).then(function (node) {
        clear(td).appendChild(node);
      }).catch(function (e) {
        clear(td).appendChild(h('div', { class: 'empty', text: '明细加载失败：' + e.message }));
      });
    });
    return tr;
  }

  function sel(pairs, value, onChange) {
    var s = h('select');
    pairs.forEach(function (p) { s.appendChild(h('option', { value: p.value, text: p.label })); });
    s.value = (value === null || value === undefined) ? '' : String(value);
    if (onChange) s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }
  function optsFromList(list) {
    return [{ value: '', label: '全部' }].concat(list.map(function (x) { return { value: x, label: x }; }));
  }
  function statusTag(status, okValue) {
    var cls = status === okValue ? 'tag-ok' : (status === '退回' || status === '停产' || status === '停用' || status === '故障' ? 'tag-danger' : 'tag-warn');
    return h('span', { class: 'tag ' + cls, text: status });
  }

  /* ================= 数据加载 ================= */
  async function loadAll() {
    var res = await Promise.all([
      api('GET', '/api/summary'),
      api('GET', '/api/settings'),
      api('GET', '/api/plants'),
      api('GET', '/api/outlets'),
      api('GET', '/api/devices'),
      api('GET', '/api/readings'),
      api('GET', '/api/reports')
    ]);
    state.summary = res[0];
    state.settings = res[1];
    state.plants = res[2];
    state.outlets = res[3];
    state.devices = res[4];
    state.readings = res[5];
    state.reports = res[6];
    state.today = state.summary.today;
    state.month = state.summary.month;
    if (!state.accounting.outletId && state.outlets.length) state.accounting.outletId = state.outlets[0].id;
    state.accounting.month = state.month;
  }

  async function reloadCore() {
    var res = await Promise.all([
      api('GET', '/api/plants'),
      api('GET', '/api/outlets'),
      api('GET', '/api/devices'),
      api('GET', '/api/reports'),
      api('GET', '/api/summary')
    ]);
    state.plants = res[0];
    state.outlets = res[1];
    state.devices = res[2];
    state.reports = res[3];
    state.summary = res[4];
  }

  function afterMutation(msg) {
    return reloadCore().then(function () {
      toast(msg);
      switchView(state.view);
    }).catch(showError);
  }

  /* ================= 视图切换 ================= */
  function switchView(view) {
    state.view = view;
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('is-active', t.dataset.view === view); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('is-active', v.dataset.view === view); });
    clearError();
    if (view === 'overview') renderOverview();
    else if (view === 'plants') renderPlants();
    else if (view === 'devices') renderDevices();
    else if (view === 'readings') renderReadings();
    else if (view === 'reconcile') renderReconcile();
    else if (view === 'accounting') renderAccounting();
  }

  function basisLabel(basis) {
    switch (basis) {
      case 'measured': return '计入·本口实测';
      case 'children': return '计入·下级合计';
      case 'fallback': return '计入·上级缺测下取';
      case 'duplicated': return '重复计量·不计入';
      default: return '当月无有效数据';
    }
  }
  function basisTag(basis) {
    if (basis === 'none' || !basis) return h('span', { class: 'sub', text: '—' });
    var cls = basis === 'measured' ? 'tag-ok' : basis === 'duplicated' ? 'tag-danger' : 'tag-warn';
    return h('span', { class: 'tag ' + cls + ' tag-mini', text: basisLabel(basis), title: basisLabel(basis) });
  }
  function depthPrefix(depth) {
    var s = '';
    for (var i = 0; i < depth; i += 1) s += (i === depth - 1 ? '└ ' : '　 ');
    return s;
  }
  // 平铺排放口列表 -> 按单位/父子关系排好的树顺序（父被筛掉时作为根兜底）
  function outletsInTreeOrder(list) {
    var byParent = {};
    list.forEach(function (o) {
      var key = o.parentId || '';
      (byParent[key] = byParent[key] || []).push(o);
    });
    Object.keys(byParent).forEach(function (k) {
      byParent[k].sort(function (a, b) { return (a.code < b.code ? -1 : 1); });
    });
    var out = [];
    var walk = function (o, depth) {
      out.push({ o: o, depth: depth });
      (byParent[o.id] || []).forEach(function (c) { walk(c, depth + 1); });
    };
    var roots = list.filter(function (o) { return !o.parentId || !list.some(function (x) { return x.id === o.parentId; }); });
    roots.sort(function (a, b) { return ((a.plantCode || '') + a.code) < ((b.plantCode || '') + b.code) ? -1 : 1; });
    roots.forEach(function (r) { walk(r, 0); });
    list.forEach(function (o) {
      if (!out.some(function (x) { return x.o.id === o.id; })) out.push({ o: o, depth: 0 });
    });
    return out;
  }

  /* ================= 概览 ================= */
  function metricCard(title, main, foot, targetView) {
    return h('button', {
      type: 'button', class: 'metric-card',
      onclick: function () { switchView(targetView); }
    }, [
      h('div', { class: 'm-title', text: title }),
      h('div', { class: 'm-main', text: String(main) }),
      h('div', { class: 'm-foot', text: foot })
    ]);
  }

  function renderOverview() {
    var f = clear(document.getElementById('filters-overview'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '概览' }),
      h('p', { class: 'hint', text: '本页年累计与本月总量均为去重口径，直接取 /api/summary 返回字段，前端不做计算。' })
    ]));

    var c = clear(document.getElementById('content-overview'));
    var s = state.summary;
    if (!s) { c.appendChild(h('div', { class: 'empty', text: '概览数据还没加载好' })); return; }

    var ds = s.deviceStatus || {};
    var dsText = Object.keys(ds).map(function (k) { return k + ' ' + ds[k] + ' 台'; }).join('、') || '暂无设备';

    c.appendChild(h('div', { class: 'metric-grid' }, [
      metricCard('排污单位', s.plantCount, '生产中 ' + s.producingCount + ' 家', 'plants'),
      metricCard('排放口', s.outletCount, '运行中 ' + s.runningOutletCount + ' 个（含下级车间排口）', 'plants'),
      metricCard('在线设备', s.deviceCount, dsText, 'devices'),
      metricCard('监测数据', s.readingCount, '自动 ' + s.autoCount + ' · 补录 ' + s.imputedCount + ' · 无效标记 ' + s.invalidFlagCount, 'readings'),
      metricCard('报表', s.reportCount, '已上报 ' + s.submittedReportCount + ' 张', 'accounting'),
      metricCard('超标排放口', s.exceededOutletCount, '存在月超标判定', 'reconcile'),
      metricCard('年累计 COD（去重）', s.accumulatedCodTons + ' 吨', '平铺合计 ' + s.accumulatedCodTonsFlat + ' · 年许可 ' + s.permitCodTons + ' 吨', 'reconcile'),
      metricCard('年累计氨氮（去重）', s.accumulatedAmmoniaTons + ' 吨', '平铺合计 ' + s.accumulatedAmmoniaTonsFlat + ' · 年许可 ' + s.permitAmmoniaTons + ' 吨', 'reconcile')
    ]));

    var tb = h('tbody');
    outletsInTreeOrder(s.outlets || []).forEach(function (x) {
      var o = x.o;
      var cod = metricOf(o.rows, 'COD');
      var amm = metricOf(o.rows, '氨氮');
      var tr = h('tr', { class: 'row', title: '点此行到「核算与报表」查看该排放口' }, [
        h('td', {}, [h('span', { class: 'muted', text: depthPrefix(o.depth || 0) }), h('b', { text: o.code }), ' ', o.name,
          o.isRoot ? '' : h('span', { class: 'tag tag-warn tag-mini', text: '下级' })]),
        h('td', { text: textOf(o.plantName) }),
        h('td', { text: textOf(o.type) }),
        h('td', {}, statusTag(o.status, '运行')),
        h('td', { class: 'mono', text: fmt(cod.monthTotalTons, 4) }),
        h('td', {}, basisTag(o.basisCod)),
        h('td', { class: 'mono', text: fmt(amm.monthTotalTons, 4) }),
        h('td', {}, basisTag(o.basisAmmonia)),
        h('td', { class: 'mono' + (Number(cod.exceedDaysCount) > 0 ? ' num-danger' : ''), text: textOf(cod.exceedDaysCount) }),
        h('td', { class: 'mono' + (Number(amm.exceedDaysCount) > 0 ? ' num-danger' : ''), text: textOf(amm.exceedDaysCount) })
      ]);
      tr.addEventListener('click', function () {
        state.accounting.outletId = o.id;
        state.accounting.month = s.month || state.month;
        switchView('accounting');
      });
      tb.appendChild(tr);
    });

    var table = h('table', { id: 'tableOverviewOutlet' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '排放口（层级）' }), h('th', { text: '所属单位' }), h('th', { text: '类型' }), h('th', { text: '状态' }),
        h('th', { text: 'COD 月总量(吨)' }), h('th', { text: 'COD 计入判定' }),
        h('th', { text: '氨氮 月总量(吨)' }), h('th', { text: '氨氮 计入判定' }),
        h('th', { text: 'COD 超标天数' }), h('th', { text: '氨氮 超标天数' })
      ])),
      tb
    ]);

    var t = s.reconcile && s.reconcile.totals ? s.reconcile.totals : null;
    var sub = '月份 ' + s.month + ' · 去重口径：总排口实测优先、缺测逐级下取，车间排口同股水不重复累加';
    if (t) {
      sub += '（集团平铺 COD ' + t.COD.flatTotalTons + '→去重 ' + t.COD.deduplicatedTotalTons +
        ' 吨；氨氮 ' + t['氨氮'].flatTotalTons + '→' + t['氨氮'].deduplicatedTotalTons + ' 吨，可在「层级核对」逐口核对）';
    }
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '本月各排放口 COD / 氨氮 情况' }),
        h('span', { class: 'sub', text: sub })
      ]),
      h('div', { class: 'table-wrap' }, table)
    ]));
  }

  /* ================= 单位与排放口 ================= */
  function plantDetailNode(id) {
    return api('GET', '/api/plants/' + id).then(function (d) {
      var box = h('div', { class: 'detail-grid' });
      var og = h('div', { class: 'detail-block' });
      og.appendChild(h('h3', { text: '排放口清单（' + ((d.outlets || []).length) + '）' }));
      if (!d.outlets || !d.outlets.length) og.appendChild(h('div', { class: 'empty', text: '暂无排放口' }));
      else {
        var tb = h('tbody');
        outletsInTreeOrder(d.outlets).forEach(function (x) {
          var o = x.o;
          tb.appendChild(h('tr', { class: 'row' }, [
            h('td', {}, [h('span', { class: 'muted', text: depthPrefix(x.depth) }), h('b', { text: o.code })]),
            h('td', { text: o.name }), h('td', { text: o.type }),
            h('td', {}, statusTag(o.status, '运行')),
            h('td', { class: 'mono', text: textOf(o.deviceCount) }), h('td', { class: 'mono', text: textOf(o.readingCount) })
          ]));
        });
        og.appendChild(h('table', {}, [h('thead', {}, h('tr', {}, [
          h('th', { text: '编码（层级）' }), h('th', { text: '名称' }), h('th', { text: '类型' }), h('th', { text: '状态' }),
          h('th', { text: '设备数' }), h('th', { text: '数据条数' })
        ])), tb]));
      }
      box.appendChild(og);

      var rg = h('div', { class: 'detail-block' });
      rg.appendChild(h('h3', { text: '报表（' + ((d.reports || []).length) + '）' }));
      if (!d.reports || !d.reports.length) rg.appendChild(h('div', { class: 'empty', text: '暂无报表' }));
      else {
        var tb2 = h('tbody');
        d.reports.forEach(function (r) {
          tb2.appendChild(h('tr', { class: 'row' }, [
            h('td', { text: r.period }), h('td', {}, statusTag(r.status, '已上报')),
            h('td', { text: textOf(r.submittedAt) }), h('td', { text: textOf(r.submittedBy) })
          ]));
        });
        rg.appendChild(h('table', {}, [h('thead', {}, h('tr', {}, [
          h('th', { text: '期间' }), h('th', { text: '状态' }), h('th', { text: '上报时刻' }), h('th', { text: '上报人' })
        ])), tb2]));
      }
      box.appendChild(rg);
      return box;
    });
  }

  function plantRow(p) {
    var actions = actionsCell([
      actionBtn('修改', function () { openPlantForm(p); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/plants/' + p.id).then(function () { return afterMutation('已删除单位 ' + p.code); });
      })
    ]);
    return expandableRow([
      h('td', {}, h('b', { text: p.code })),
      h('td', { text: p.name }),
      h('td', { text: textOf(p.industry) }),
      h('td', {}, statusTag(p.status, '生产')),
      h('td', { text: textOf(p.permitNo) }),
      h('td', { class: 'mono', text: textOf(p.outletCount) }),
      h('td', { class: 'mono', text: textOf(p.deviceCount) }),
      h('td', { class: 'mono', text: textOf(p.readingCount) }),
      h('td', { class: 'mono', text: textOf(p.reportCount) }),
      actions
    ], function () { return plantDetailNode(p.id); });
  }

  function outletRow(o, depth) {
    depth = depth || 0;
    var actions = actionsCell([
      actionBtn('修改', function () { openOutletForm(o); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/outlets/' + o.id).then(function () { return afterMutation('已删除排放口 ' + o.code); });
      })
    ]);
    return expandableRow([
      h('td', {}, [h('span', { class: 'muted', text: depthPrefix(depth) }), h('b', { text: o.code })]),
      h('td', { text: textOf(o.name) }),
      h('td', { text: textOf(o.plantCode + ' ' + o.plantName).trim() || '—' }),
      h('td', {}, o.parentId
        ? h('span', { class: 'sub', text: '└ ' + textOf(o.parentCode) })
        : h('span', { class: 'tag tag-ok tag-mini', text: '独立 / 总排口' })),
      h('td', { text: textOf(o.type) }),
      h('td', {}, statusTag(o.status, '运行')),
      h('td', { class: 'mono', text: textOf(o.deviceCount) }),
      h('td', { class: 'mono', text: textOf(o.readingCount) }),
      actions
    ], function () {
      var box = h('div', { class: 'detail-grid' });
      var info = h('div', { class: 'detail-block' });
      info.appendChild(h('h3', { text: '层级与备注' }));
      info.appendChild(h('div', { class: 'section-note' }, o.parentId
        ? ['上级排口：', h('b', { text: textOf(o.parentCode + ' ' + o.parentName) }), '（出水汇入上级，同股水在上级计量）']
        : '无上级排口，属独立排向环境的总排口；下挂下级 ' + textOf(o.childrenCount) + ' 个。'));
      info.appendChild(h('div', { text: textOf(o.remark) }));
      box.appendChild(info);
      var devs = state.devices.filter(function (d) { return d.outletId === o.id; });
      var db = h('div', { class: 'detail-block' });
      db.appendChild(h('h3', { text: '设备（' + devs.length + '）' }));
      if (!devs.length) db.appendChild(h('div', { class: 'empty', text: '暂无设备' }));
      else {
        var tb = h('tbody');
        devs.forEach(function (d) {
          tb.appendChild(h('tr', { class: 'row' }, [
            h('td', { text: d.code }), h('td', { text: d.metric }), h('td', {}, statusTag(d.status, '正常')),
            h('td', { text: textOf(d.calibratedUntil) })
          ]));
        });
        db.appendChild(h('table', {}, [h('thead', {}, h('tr', {}, [
          h('th', { text: '编号' }), h('th', { text: '指标' }), h('th', { text: '状态' }), h('th', { text: '校准有效期' })
        ])), tb]));
      }
      box.appendChild(db);
      return box;
    });
  }

  async function renderPlants() {
    var f = clear(document.getElementById('filters-plants'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '排污单位' }),
      h('div', { class: 'field' }, [h('label', { text: '状态' }),
        sel(optsFromList(PLANT_STATUS), state.plantsFilter.status, function (v) { state.plantsFilter.status = v; renderPlants(); })]),
      (function () {
        var kw = h('input', { type: 'text', placeholder: '编码/名称/行业' });
        kw.value = state.plantsFilter.keyword;
        kw.addEventListener('keydown', function (e) { if (e.key === 'Enter') { state.plantsFilter.keyword = kw.value.trim(); renderPlants(); } });
        return h('div', { class: 'field' }, [h('label', { text: '关键字' }), kw, h('div', { class: 'hint', text: '回车应用（走接口筛选）' })]);
      })()
    ]));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '排放口' }),
      h('div', { class: 'field' }, [h('label', { text: '所属单位' }),
        sel([{ value: '', label: '全部单位' }].concat(state.plants.map(function (p) { return { value: p.id, label: p.code + ' ' + p.name }; })),
          state.outletsFilter.plantId, function (v) { state.outletsFilter.plantId = v; renderPlants(); })]),
      h('div', { class: 'field' }, [h('label', { text: '状态' }),
        sel(optsFromList(OUTLET_STATUS), state.outletsFilter.status, function (v) { state.outletsFilter.status = v; renderPlants(); })])
    ]));

    var c = clear(document.getElementById('content-plants'));
    var plantsRes, outletsRes;
    try {
      plantsRes = await api('GET', '/api/plants' + qs(state.plantsFilter));
      outletsRes = await api('GET', '/api/outlets' + qs(state.outletsFilter));
    } catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }

    var unitTb = h('tbody');
    plantsRes.forEach(function (p) { unitTb.appendChild(plantRow(p)); });
    var unitTable = h('table', { id: 'tableUnits' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '编码' }), h('th', { text: '名称' }), h('th', { text: '行业' }), h('th', { text: '状态' }),
        h('th', { text: '许可证号' }), h('th', { text: '排放口数' }), h('th', { text: '设备数' }),
        h('th', { text: '数据条数' }), h('th', { text: '报表数' }), h('th', { text: '操作' })
      ])),
      unitTb
    ]);
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '排污单位台账' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + plantsRes.length + ' 家（点行展开排放口与报表）' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新增单位', onclick: function () { openPlantForm(null); } })
        ])
      ]),
      h('div', { class: 'table-wrap' }, unitTable)
    ]));

    var outletTb = h('tbody');
    outletsInTreeOrder(outletsRes).forEach(function (x) { outletTb.appendChild(outletRow(x.o, x.depth)); });
    var outletTable = h('table', { id: 'tableOutlets' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '编码' }), h('th', { text: '名称' }), h('th', { text: '所属单位' }), h('th', { text: '上级排口' }),
        h('th', { text: '类型' }),
        h('th', { text: '状态' }), h('th', { text: '设备数' }), h('th', { text: '数据条数' }), h('th', { text: '操作' })
      ])),
      outletTb
    ]);
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '排放口台账（层级）' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + outletsRes.length + ' 个，按单位层级展示；└ 为下级（车间）排口，无上级的为独立总排口' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新增排放口', onclick: function () { openOutletForm(null); } })
        ])
      ]),
      h('div', { class: 'table-wrap' }, outletTable)
    ]));
  }

  function openPlantForm(plant) {
    var fields = [
      { name: 'code', label: '编码' },
      { name: 'name', label: '名称' },
      { name: 'industry', label: '行业' },
      { name: 'status', label: '状态', type: 'select', options: PLANT_STATUS },
      { name: 'permitNo', label: '排污许可证号' },
      { name: 'permitYearStart', label: '许可年起始日（YYYY-MM-DD）' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, plant || { status: '生产', permitYearStart: (state.settings && state.settings.permitYearStart) || '2026-01-01' });
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      var p = plant ? api('PATCH', '/api/plants/' + plant.id, payload) : api('POST', '/api/plants', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(plant ? '单位已修改' : '单位已新增'); }).catch(showError);
    });
    openModal(plant ? '修改排污单位' : '新增排污单位', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  function openOutletForm(outlet) {
    var fields = [
      { name: 'code', label: '编码' },
      { name: 'name', label: '名称' },
      { name: 'plantId', label: '所属单位', type: 'select', options: state.plants.map(function (p) { return { value: p.id, label: p.code + ' ' + p.name }; }) },
      { name: 'parentId', label: '上级排口（不选 = 独立总排口）', type: 'select', options: [] },
      { name: 'type', label: '类型', type: 'select', options: OUTLET_TYPE },
      { name: 'status', label: '状态', type: 'select', options: OUTLET_STATUS },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, outlet || { type: '主要排放口', status: '运行', plantId: state.plants.length ? state.plants[0].id : '', parentId: '' });
    var plantSel = form.querySelector('[data-field="plantId"]');
    var parentSel = form.querySelector('[data-field="parentId"]');
    function refillParents() {
      var cur = parentSel.value;
      parentSel.innerHTML = '';
      parentSel.appendChild(h('option', { value: '', text: '无（独立排口 / 总排口）' }));
      state.outlets
        .filter(function (o) { return o.plantId === plantSel.value && (!outlet || o.id !== outlet.id); })
        .forEach(function (o) {
          var prefix = o.parentId ? '　' : '';
          parentSel.appendChild(h('option', { value: o.id, text: prefix + o.code + ' ' + o.name }));
        });
      parentSel.value = cur || '';
    }
    plantSel.addEventListener('change', refillParents);
    refillParents();
    if (outlet) parentSel.value = outlet.parentId || '';
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      var p = outlet ? api('PATCH', '/api/outlets/' + outlet.id, payload) : api('POST', '/api/outlets', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(outlet ? '排放口已修改' : '排放口已新增'); }).catch(showError);
    });
    openModal(outlet ? '修改排放口' : '新增排放口', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  /* ================= 在线设备 ================= */
  function deviceRow(d) {
    var actions = actionsCell([
      actionBtn('修改', function () { openDeviceForm(d); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/devices/' + d.id).then(function () { return afterMutation('已删除设备 ' + d.code); });
      })
    ]);
    var outlet = state.outlets.filter(function (o) { return o.id === d.outletId; })[0];
    return expandableRow([
      h('td', {}, h('b', { text: d.code })),
      h('td', { text: outlet ? (outlet.code + ' ' + outlet.name) : textOf(d.outletCode) }),
      h('td', { text: d.metric }),
      h('td', { text: textOf(d.model) }),
      h('td', {}, statusTag(d.status, '正常')),
      h('td', { text: textOf(d.calibratedUntil) }),
      h('td', { class: 'mono', text: textOf(d.readingCount) }),
      h('td', { class: 'mono' + (Number(d.invalidCount) > 0 ? ' num-danger' : ''), text: textOf(d.invalidCount) }),
      actions
    ], function () {
      return h('div', { class: 'detail-grid' }, [
        h('div', { class: 'detail-block' }, [h('h3', { text: '设备 ID' }), h('div', { text: d.id })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '备注' }), h('div', { text: textOf(d.remark) })])
      ]);
    });
  }

  async function renderDevices() {
    var f = clear(document.getElementById('filters-devices'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '设备筛选' }),
      h('div', { class: 'field' }, [h('label', { text: '所属排放口' }),
        sel([{ value: '', label: '全部排放口' }].concat(state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; })),
          state.devicesFilter.outletId, function (v) { state.devicesFilter.outletId = v; renderDevices(); })]),
      h('div', { class: 'field' }, [h('label', { text: '监测指标' }),
        sel(optsFromList(METRICS), state.devicesFilter.metric, function (v) { state.devicesFilter.metric = v; renderDevices(); })]),
      h('div', { class: 'field' }, [h('label', { text: '设备状态' }),
        sel(optsFromList(DEVICE_STATUS), state.devicesFilter.status, function (v) { state.devicesFilter.status = v; renderDevices(); })])
    ]));

    var c = clear(document.getElementById('content-devices'));
    var list;
    try { list = await api('GET', '/api/devices' + qs(state.devicesFilter)); }
    catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }

    var tb = h('tbody');
    list.forEach(function (d) { tb.appendChild(deviceRow(d)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '在线设备台账' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + list.length + ' 台' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新增设备', onclick: function () { openDeviceForm(null); } })
        ])
      ]),
      h('div', { class: 'table-wrap' }, h('table', { id: 'tableDevices' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '编号' }), h('th', { text: '所属排放口' }), h('th', { text: '指标' }), h('th', { text: '型号' }),
          h('th', { text: '状态' }), h('th', { text: '校准有效期' }), h('th', { text: '数据条数' }),
          h('th', { text: '无效标记条数' }), h('th', { text: '操作' })
        ])),
        tb
      ]))
    ]));
  }

  function openDeviceForm(device) {
    var fields = [
      { name: 'code', label: '设备编号' },
      { name: 'outletId', label: '所属排放口', type: 'select', options: state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; }) },
      { name: 'metric', label: '监测指标', type: 'select', options: METRICS },
      { name: 'model', label: '型号' },
      { name: 'status', label: '设备状态', type: 'select', options: DEVICE_STATUS },
      { name: 'calibratedUntil', label: '校准有效期（YYYY-MM-DD）' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, device || { status: '正常', metric: 'COD', outletId: state.outlets.length ? state.outlets[0].id : '' });
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      var p = device ? api('PATCH', '/api/devices/' + device.id, payload) : api('POST', '/api/devices', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(device ? '设备已修改' : '设备已新增'); }).catch(showError);
    });
    openModal(device ? '修改设备' : '新增设备', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  /* ================= 监测数据 ================= */
  function readingRow(r) {
    var pc = pageConcentration(r);
    var actions = actionsCell([
      actionBtn('修改', function () { openReadingForm(r); }),
      deleteBtn('删除', function () {
        return api('DELETE', '/api/readings/' + r.id).then(function () { return afterMutation('已删除监测数据 ' + r.id); });
      })
    ]);
    return expandableRow([
      h('td', { text: textOf(r.outletCode) }),
      h('td', { text: textOf(r.deviceCode) }),
      h('td', { text: r.metric }),
      h('td', { class: 'nowrap', text: r.at }),
      h('td', { class: 'mono', text: textOf(r.value) }),
      h('td', {}, h('span', { class: 'tag ' + (r.flag === '有效' ? 'tag-ok' : 'tag-danger'), text: r.flag })),
      h('td', { text: r.source }),
      h('td', { text: textOf(r.operator) }),
      h('td', {}, h('span', { class: 'tag ' + (r.counted ? 'tag-ok' : 'tag-danger'), text: r.counted ? '计入' : '不计入' })),
      h('td', { class: 'mono cell-page-conc', dataset: { value: pc === null ? '' : String(pc) }, text: pc === null ? '—' : fmt(pc, 2) }),
      h('td', { class: 'mono cell-api-conc', dataset: { value: (r.concentration === null || r.concentration === undefined) ? '' : String(r.concentration) }, text: textOf(r.concentration) }),
      h('td', { class: 'mono', text: textOf(r.oxygen) }),
      h('td', { class: 'mono', text: textOf(r.flow) }),
      actions
    ], function () {
      return h('div', { class: 'detail-grid' }, [
        h('div', { class: 'detail-block' }, [h('h3', { text: '数据 ID' }), h('div', { text: r.id })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '设备状态' }), h('div', { text: textOf(r.deviceStatus) })]),
        h('div', { class: 'detail-block' }, [h('h3', { text: '备注' }), h('div', { text: textOf(r.remark) })])
      ]);
    });
  }

  async function renderReadings() {
    var f = clear(document.getElementById('filters-readings'));
    var outletSel = sel([{ value: '', label: '全部排放口' }].concat(state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; })),
      state.readingsFilter.outletId, function (v) {
        state.readingsFilter.outletId = v;
        if (v && state.readingsFilter.deviceId) {
          var ok = state.devices.some(function (d) { return d.id === state.readingsFilter.deviceId && d.outletId === v; });
          if (!ok) state.readingsFilter.deviceId = '';
        }
        renderReadings();
      });
    var devPool = state.readingsFilter.outletId
      ? state.devices.filter(function (d) { return d.outletId === state.readingsFilter.outletId; })
      : state.devices;
    var deviceSel = sel([{ value: '', label: '全部设备' }].concat(devPool.map(function (d) { return { value: d.id, label: d.code }; })),
      state.readingsFilter.deviceId, function (v) { state.readingsFilter.deviceId = v; renderReadings(); });
    var metricSel = sel(optsFromList(METRICS), state.readingsFilter.metric, function (v) { state.readingsFilter.metric = v; renderReadings(); });
    var dayInput = h('input', { type: 'date' });
    dayInput.value = state.readingsFilter.day;
    dayInput.addEventListener('change', function () { state.readingsFilter.day = dayInput.value; renderReadings(); });
    var monthInput = h('input', { type: 'month' });
    monthInput.value = state.readingsFilter.month;
    monthInput.addEventListener('change', function () { state.readingsFilter.month = monthInput.value; renderReadings(); });

    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '监测数据筛选' }),
      h('div', { class: 'field' }, [h('label', { text: '排放口' }), outletSel]),
      h('div', { class: 'field' }, [h('label', { text: '设备' }), deviceSel]),
      h('div', { class: 'field' }, [h('label', { text: '指标' }), metricSel]),
      h('div', { class: 'field' }, [h('label', { text: '日期' }), dayInput]),
      h('div', { class: 'field' }, [h('label', { text: '月份' }), monthInput]),
      h('div', { class: 'field' }, [h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: '清空筛选', onclick: function () {
        state.readingsFilter = { outletId: '', deviceId: '', metric: '', day: '', month: '' };
        renderReadings();
      } })])
    ]));

    var c = clear(document.getElementById('content-readings'));
    var data;
    try { data = await api('GET', '/api/readings' + qs(state.readingsFilter)); }
    catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }
    state.readings = data;

    var tb = h('tbody');
    (data.rows || []).forEach(function (r) { tb.appendChild(readingRow(r)); });

    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '小时值清单' }),
        h('div', { class: 'btn-row' }, [
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新增监测数据', onclick: function () { openReadingForm(null); } })
        ])
      ]),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'section-note' }, [
          '共 ', h('b', { text: String(data.total) }), ' 条，已显示前 ', h('b', { text: String(data.returned) }), ' 条（总条数与已显示条数取自接口 total 与 returned）。'
        ]),
        h('div', { class: 'section-note' }, [
          '「折算后浓度（页面自算）」由本页按 实测 × (21 − 基准氧) / (21 − 氧含量) 计算，氧含量取接口 oxygen，缺失按 0 代入；「接口折算浓度」直接显示接口 concentration。'
        ]),
        h('div', { class: 'table-wrap' }, h('table', { id: 'tableReadings' }, [
          h('thead', {}, h('tr', {}, [
            h('th', { text: '排放口' }), h('th', { text: '设备' }), h('th', { text: '指标' }), h('th', { text: '时刻' }),
            h('th', { text: '数值' }), h('th', { text: '标记' }), h('th', { text: '来源' }), h('th', { text: '登记人' }),
            h('th', { text: '是否计入' }), h('th', { text: '折算后浓度（页面自算）' }), h('th', { text: '接口折算浓度' }),
            h('th', { text: '当时氧含量' }), h('th', { text: '当时流量' }), h('th', { text: '操作' })
          ])),
          tb
        ]))
      ])
    ]));
  }

  function openReadingForm(reading) {
    var fields = [
      { name: 'outletId', label: '排放口', type: 'select', options: state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; }) },
      { name: 'deviceId', label: '设备', type: 'select', options: state.devices.map(function (d) { return { value: d.id, label: d.code + '（' + d.metric + '）' }; }) },
      { name: 'metric', label: '指标', type: 'select', options: METRICS },
      { name: 'at', label: '时刻（YYYY-MM-DD HH:00:00）' },
      { name: 'value', label: '数值', type: 'number' },
      { name: 'flag', label: '标记', type: 'select', options: FLAGS },
      { name: 'source', label: '来源', type: 'select', options: SOURCES },
      { name: 'operator', label: '登记人' },
      { name: 'remark', label: '备注', full: true }
    ];
    var defaults = reading || {
      outletId: state.outlets.length ? state.outlets[0].id : '',
      deviceId: state.devices.length ? state.devices[0].id : '',
      metric: 'COD', at: (state.month || '2026-09') + '-01 08:00:00', value: '', flag: '有效', source: '自动', operator: '', remark: ''
    };
    var form = buildForm(fields, defaults);
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var raw = collectForm(form);
      var payload = {
        at: raw.at, flag: raw.flag, source: raw.source, remark: raw.remark,
        value: raw.value === '' ? undefined : Number(raw.value)
      };
      if (!reading) {
        payload.outletId = raw.outletId;
        payload.deviceId = raw.deviceId;
        payload.metric = raw.metric;
        payload.operator = raw.operator;
      } else {
        payload.operator = undefined;
      }
      if (payload.value === undefined) delete payload.value;
      if (payload.operator === undefined) delete payload.operator;
      var p = reading ? api('PATCH', '/api/readings/' + reading.id, payload) : api('POST', '/api/readings', payload);
      Promise.resolve(p).then(function () { closeModal(); return afterMutation(reading ? '监测数据已修改' : '监测数据已新增'); }).catch(showError);
    });
    openModal(reading ? '修改监测数据' : '新增监测数据', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  /* ================= 核算与报表 ================= */
  function summaryCard(sum, metric) {
    var row = metricOf(sum.rows, metric);
    var st = sum.settings || {};
    var cells = [
      ['月均', fmt(row.monthAverage)],
      ['月总量(吨)', fmt(row.monthTotalTons, 4)],
      ['季度总量 COD(吨)', fmt(sum.quarterTotalCod, 4)],
      ['季度许可量 COD(吨)', fmt(sum.permitCodTons, 4)],
      ['年累计 COD(吨)', fmt(sum.accumulatedCodTons, 4)],
      ['年许可量 COD(吨)', fmt(sum.annualPermitCodTons, 4)],
      ['超标天数', textOf(row.exceedDaysCount)],
      ['超标小时数', textOf(row.exceedHours)],
      ['限值', textOf(row.limit)],
      ['超标判定', row.exceeded ? '超标' : '达标'],
      ['年累计氨氮(吨)', fmt(sum.accumulatedAmmoniaTons, 4)],
      ['年许可量氨氮(吨)', fmt(st.annualPermitAmmoniaTons, 4)]
    ];
    var grid = h('div', { class: 'summary-grid' });
    cells.forEach(function (p) {
      var cls = '';
      if (p[0] === '超标判定') cls = p[1] === '超标' ? ' num-danger' : ' num-ok';
      grid.appendChild(h('div', { class: 'summary-cell' }, [
        h('div', { class: 'k', text: p[0] }),
        h('div', { class: 'v' + cls, text: p[1] })
      ]));
    });
    return grid;
  }

  function hourlyTable(rows) {
    var tb = h('tbody');
    (rows || []).forEach(function (r) {
      tb.appendChild(h('tr', { class: 'row' }, [
        h('td', { class: 'nowrap', text: r.at }),
        h('td', { class: 'mono', text: textOf(r.hour) }),
        h('td', { class: 'mono', text: textOf(r.value) }),
        h('td', { text: r.source }),
        h('td', {}, h('span', { class: 'tag ' + (r.flag === '有效' ? 'tag-ok' : 'tag-danger'), text: r.flag })),
        h('td', { text: textOf(r.deviceCode) }),
        h('td', {}, statusTag(r.deviceStatus, '正常')),
        h('td', { class: 'mono', text: textOf(r.oxygen) }),
        h('td', { class: 'mono', text: textOf(r.flow) }),
        h('td', { text: r.counted ? '计入' : '不计入' }),
        h('td', { class: 'mono', text: textOf(r.concentration) })
      ]));
    });
    return h('table', { class: 'mini-table' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '时刻' }), h('th', { text: '小时' }), h('th', { text: '数值' }), h('th', { text: '来源' }),
        h('th', { text: '标记' }), h('th', { text: '设备' }), h('th', { text: '设备状态' }),
        h('th', { text: '氧含量' }), h('th', { text: '流量' }), h('th', { text: '是否计入' }), h('th', { text: '接口折算浓度' })
      ])),
      tb
    ]);
  }

  function dailyRow(d, metric) {
    return expandableRow([
      h('td', { class: 'nowrap', text: d.day }),
      h('td', { class: 'mono', text: textOf(d.countedHours) }),
      h('td', { class: 'mono', text: textOf(d.imputedHours) }),
      h('td', { class: 'mono', text: fmt(d.average) }),
      h('td', { class: 'mono', text: textOf(d.limit) }),
      h('td', {}, h('span', { class: 'tag ' + (d.exceed ? 'tag-danger' : 'tag-ok'), text: d.exceed ? '超标' : '达标' })),
      h('td', { class: 'mono', text: fmt(d.flowTotal, 1) })
    ], function () {
      var wrap = h('div');
      wrap.appendChild(h('div', { class: 'section-note', text: d.day + ' · ' + metric + ' 逐小时明细（共 ' + ((d.rows || []).length) + ' 小时）' }));
      wrap.appendChild(h('div', { class: 'table-wrap' }, hourlyTable(d.rows)));
      return wrap;
    });
  }

  async function reportDetailNode(id) {
    var rep = await api('GET', '/api/reports/' + id);
    var box = h('div');
    box.appendChild(h('div', { class: 'section-note' }, [
      h('b', { text: '单位：' }), rep.plant ? ((rep.plant.code || '') + ' ' + (rep.plant.name || '')) : '—',
      '　', h('b', { text: '期间：' }), rep.period, '　', h('b', { text: '月份：' }), rep.month
    ]));
    var outs = rep.outlets || [];
    if (!outs.length) box.appendChild(h('div', { class: 'empty', text: '该单位本月没有排放口数据' }));
    outs.forEach(function (os) {
      var ob = h('div', { class: 'detail-block' });
      ob.appendChild(h('h3', { text: (os.outlet ? (os.outlet.code + ' ' + os.outlet.name) : '排放口') + ' 汇总' }));
      var t = h('table', { class: 'mini-table' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '指标' }), h('th', { text: '月均' }), h('th', { text: '月总量(吨)' }), h('th', { text: '超标天数' }),
          h('th', { text: '超标小时' }), h('th', { text: '限值' }), h('th', { text: '超标' })
        ])),
        (function () {
          var tb = h('tbody');
          (os.rows || []).forEach(function (r) {
            tb.appendChild(h('tr', { class: 'row' }, [
              h('td', { text: r.metric }), h('td', { class: 'mono', text: fmt(r.monthAverage) }),
              h('td', { class: 'mono', text: fmt(r.monthTotalTons, 4) }), h('td', { class: 'mono', text: textOf(r.exceedDaysCount) }),
              h('td', { class: 'mono', text: textOf(r.exceedHours) }), h('td', { class: 'mono', text: textOf(r.limit) }),
              h('td', {}, h('span', { class: 'tag ' + (r.exceeded ? 'tag-danger' : 'tag-ok'), text: r.exceeded ? '超标' : '达标' }))
            ]));
          });
          return tb;
        })()
      ]);
      ob.appendChild(t);

      var dailyBlock = h('div', { class: 'detail-block' });
      dailyBlock.appendChild(h('h3', { text: '逐日明细' }));
      var holder = h('div', { class: 'empty', text: '加载中…' });
      dailyBlock.appendChild(holder);
      ob.appendChild(dailyBlock);
      box.appendChild(ob);

      api('GET', '/api/outlets/' + os.outlet.id + '/daily' + qs({ month: rep.month })).then(function (dd) {
        clear(holder);
        MAIN_METRICS.forEach(function (m) {
          var series = (dd.metrics || {})[m] || [];
          holder.appendChild(h('div', { class: 'section-note', text: m + ' 逐日（' + series.length + ' 天）' }));
          if (!series.length) { holder.appendChild(h('div', { class: 'empty', text: '本月没有 ' + m + ' 数据' })); return; }
          var tb = h('tbody');
          series.forEach(function (d) {
            tb.appendChild(h('tr', { class: 'row' }, [
              h('td', { class: 'nowrap', text: d.day }), h('td', { class: 'mono', text: textOf(d.countedHours) }),
              h('td', { class: 'mono', text: textOf(d.imputedHours) }), h('td', { class: 'mono', text: fmt(d.average) }),
              h('td', { class: 'mono', text: textOf(d.limit) }),
              h('td', {}, h('span', { class: 'tag ' + (d.exceed ? 'tag-danger' : 'tag-ok'), text: d.exceed ? '超标' : '达标' })),
              h('td', { class: 'mono', text: fmt(d.flowTotal, 1) })
            ]));
          });
          holder.appendChild(h('div', { class: 'table-wrap' }, h('table', { class: 'mini-table' }, [
            h('thead', {}, h('tr', {}, [
              h('th', { text: '日期' }), h('th', { text: '有效小时数' }), h('th', { text: '补录小时数' }),
              h('th', { text: '日均' }), h('th', { text: '限值' }), h('th', { text: '是否超标' }), h('th', { text: '当日流量合计' })
            ])),
            tb
          ])));
        });
      }).catch(function (e) { holder.textContent = '逐日明细加载失败：' + e.message; });
    });
    return box;
  }

  function reportRow(r) {
    var statusSel = sel(REPORT_STATUS.map(function (s) { return { value: s, label: s }; }), r.status, null);
    statusSel.addEventListener('click', function (e) { e.stopPropagation(); });
    statusSel.addEventListener('change', function (e) {
      e.stopPropagation();
      api('PATCH', '/api/reports/' + r.id, { status: statusSel.value }).then(function () {
        return afterMutation('报表状态已改为 ' + statusSel.value);
      }).catch(function (err) { showError(err); statusSel.value = r.status; });
    });
    var actions = actionsCell([
      statusSel,
      actionBtn('改备注', function () { openReportEdit(r); })
    ]);
    return expandableRow([
      h('td', { text: r.period }),
      h('td', {}, statusTag(r.status, '已上报')),
      h('td', { text: textOf(r.submittedAt) }),
      h('td', { text: textOf(r.submittedBy) }),
      h('td', { text: textOf(r.remark) }),
      actions
    ], function () { return reportDetailNode(r.id); });
  }

  function openReportForm() {
    var fields = [
      { name: 'plantId', label: '排污单位', type: 'select', options: state.plants.map(function (p) { return { value: p.id, label: p.code + ' ' + p.name }; }) },
      { name: 'period', label: '期间（YYYY-MM）', type: 'month' },
      { name: 'status', label: '状态', type: 'select', options: REPORT_STATUS },
      { name: 'submittedBy', label: '上报人' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, { plantId: state.plants.length ? state.plants[0].id : '', period: state.month || '', status: '草稿' });
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '新建报表' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      api('POST', '/api/reports', payload).then(function () { closeModal(); return afterMutation('报表已新建'); }).catch(showError);
    });
    openModal('新建报表', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  function openReportEdit(r) {
    var fields = [
      { name: 'status', label: '状态', type: 'select', options: REPORT_STATUS },
      { name: 'submittedAt', label: '上报时刻' },
      { name: 'submittedBy', label: '上报人' },
      { name: 'remark', label: '备注', full: true }
    ];
    var form = buildForm(fields, r);
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存' });
    save.addEventListener('click', function () {
      var payload = collectForm(form);
      api('PATCH', '/api/reports/' + r.id, payload).then(function () { closeModal(); return afterMutation('报表已更新'); }).catch(showError);
    });
    openModal('修改报表', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  async function renderAccounting() {
    if (!state.accounting.outletId && state.outlets.length) state.accounting.outletId = state.outlets[0].id;
    if (!state.accounting.month) state.accounting.month = state.month;

    var f = clear(document.getElementById('filters-accounting'));
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '核算对象' }),
      h('div', { class: 'field' }, [h('label', { text: '排放口' }),
        sel(state.outlets.map(function (o) { return { value: o.id, label: o.code + ' ' + o.name }; }),
          state.accounting.outletId, function (v) { state.accounting.outletId = v; renderAccounting(); })]),
      h('div', { class: 'field' }, [h('label', { text: '月份' }),
        (function () {
          var mi = h('input', { type: 'month' });
          mi.value = state.accounting.month;
          mi.addEventListener('change', function () { state.accounting.month = mi.value; renderAccounting(); });
          return mi;
        })()]),
      h('div', { class: 'field' }, [h('label', { text: '指标' }),
        sel(MAIN_METRICS.map(function (m) { return { value: m, label: m }; }), state.accounting.metric,
          function (v) { state.accounting.metric = v; renderAccounting(); })])
    ]));

    var c = clear(document.getElementById('content-accounting'));
    if (!state.accounting.outletId) { c.appendChild(h('div', { class: 'empty', text: '没有可选排放口' })); return; }
    var month = state.accounting.month || state.month;
    var metric = state.accounting.metric || 'COD';

    var sum, daily;
    try {
      var out = await Promise.all([
        api('GET', '/api/outlets/' + state.accounting.outletId + '/summary' + qs({ month: month })),
        api('GET', '/api/outlets/' + state.accounting.outletId + '/daily' + qs({ month: month, metric: metric }))
      ]);
      sum = out[0]; daily = out[1];
    } catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }

    var acOutlet = state.outlets.filter(function (o) { return o.id === state.accounting.outletId; })[0];
    if (acOutlet && acOutlet.parentId) {
      c.appendChild(h('div', { class: 'card notice-card' }, [
        h('div', { class: 'card-body' }, h('div', { class: 'section-note' }, [
          h('b', { text: '层级口径提示：' }),
          '本排口是「' + acOutlet.parentCode + ' ' + acOutlet.parentName + '」的下级排口，出水汇入上级、同股水在总排口已计量。单位/集团总量按总排口实测计入、本排口不重复累加（仅当总排口缺测时才取本排口等下级合计下取）。本页数字是本排口自身的过程监测值，去重后的总量请到「层级核对」查看。'
        ]))
      ]));
    }
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: (sum.outlet ? (sum.outlet.code + ' ' + sum.outlet.name) : '排放口') + ' 汇总' }),
        h('span', { class: 'sub', text: (sum.plant ? (sum.plant.code + ' ' + sum.plant.name) : '') + ' · ' + month + ' · ' + metric })
      ]),
      h('div', { class: 'card-body' }, summaryCard(sum, metric))
    ]));

    var series = (daily.metrics || {})[metric] || [];
    var dailyTb = h('tbody');
    series.forEach(function (d) { dailyTb.appendChild(dailyRow(d, metric)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: metric + ' 逐日明细' }),
        h('span', { class: 'sub', text: '共 ' + series.length + ' 天（点某天展开逐小时明细）' })
      ]),
      h('div', { class: 'table-wrap' }, h('table', { id: 'tableDaily' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '日期' }), h('th', { text: '有效小时数' }), h('th', { text: '补录小时数' }), h('th', { text: '日均' }),
          h('th', { text: '限值' }), h('th', { text: '是否超标' }), h('th', { text: '当日流量合计' })
        ])),
        dailyTb
      ]))
    ]));

    var reportTb = h('tbody');
    state.reports.forEach(function (r) { reportTb.appendChild(reportRow(r)); });
    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '报表' }),
        h('div', { class: 'btn-row' }, [
          h('span', { class: 'sub', text: '共 ' + state.reports.length + ' 张（点行展开详情）' }),
          h('button', { type: 'button', class: 'btn btn-sm btn-accent', text: '新建报表', onclick: openReportForm })
        ])
      ]),
      h('div', { class: 'table-wrap' }, h('table', { id: 'tableReports' }, [
        h('thead', {}, h('tr', {}, [
          h('th', { text: '期间' }), h('th', { text: '状态' }), h('th', { text: '上报时刻' }), h('th', { text: '上报人' }),
          h('th', { text: '备注' }), h('th', { text: '操作' })
        ])),
        reportTb
      ]))
    ]));
  }

  /* ================= 层级核对 ================= */
  var reconcileState = { month: '', data: null };

  function reconcileTotalsTable(totals) {
    var order = ['COD', '氨氮'];
    var tb = h('tbody');
    order.forEach(function (mt) {
      var t = totals[mt];
      tb.appendChild(h('tr', {}, [
        h('td', {}, h('b', { text: mt })),
        h('td', { class: 'mono', text: fmt(t.flatTotalTons, 4) }),
        h('td', { class: 'mono num-ok', text: fmt(t.deduplicatedTotalTons, 4) }),
        h('td', { class: 'mono num-danger', text: fmt(t.doubleCountedTons, 4) }),
        h('td', { class: 'mono', text: fmt(t.countedDetailTons, 4) }),
        h('td', {}, t.matched
          ? h('span', { class: 'tag tag-ok', text: '一致 · 差额 0' })
          : h('span', { class: 'tag tag-danger', text: '差额 ' + fmt(t.countedDetailTons - t.deduplicatedTotalTons, 4) }))
      ]));
    });
    return h('table', { class: 'mini-table' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '指标' }), h('th', { text: '平铺合计（含重复）' }), h('th', { text: '去重后合计（法定口径）' }),
        h('th', { text: '重复差额' }), h('th', { text: '逐排口明细相加' }), h('th', { text: '核对结果' })
      ])),
      tb
    ]);
  }

  function reconcileJudgeTag(o, mt) {
    var map = {
      measured: ['tag-ok', '计入', '计入总量：以本口（独立总排口）实测为准'],
      children: ['tag-warn', '下级合计', '本口当月缺测，计入其下级实测合计（逐级下取）'],
      fallback: ['tag-warn', '下取计入', '上级总排口缺测，本口实测被上取计入该分支总量'],
      duplicated: ['tag-danger', '重复不计', '同股水已在上级总排口计量，按总排口口径只计一次，本口扣减'],
      none: ['tag-muted', '无数据', '当月没有有效计量数据']
    };
    var m = map[o.basis[mt]] || map.none;
    return h('span', { class: 'tag ' + m[0] + ' tag-mini', text: m[1], title: m[2] });
  }

  function reconcileOutletTable(pr) {
    var codeById = {};
    (pr.outlets || []).forEach(function (o) { codeById[o.id] = o.code; });
    var tb = h('tbody');
    pr.outlets.forEach(function (o) {
      var childTitle = function (mt) {
        var ids = (o.sourceOutletIds[mt] || []).map(function (id) { return codeById[id] || id; });
        return ids.length ? ('取下级排口：' + ids.join('、')) : '';
      };
      var codTag = reconcileJudgeTag(o, 'COD');
      if (o.basis.COD === 'children') codTag.title = '计入下级实测合计：' + childTitle('COD');
      var ammTag = reconcileJudgeTag(o, '氨氮');
      if (o.basis['氨氮'] === 'children') ammTag.title = '计入下级实测合计：' + childTitle('氨氮');
      tb.appendChild(h('tr', { class: 'row' + (o.depth ? ' row-child' : '') }, [
        h('td', {}, [h('span', { class: 'muted', text: depthPrefix(o.depth) }), h('b', { text: o.code }), ' ', o.name]),
        h('td', { text: textOf(o.type) }),
        h('td', {}, statusTag(o.status, '运行')),
        h('td', { class: 'mono', text: fmt(o.measuredTons.COD, 4) }),
        h('td', {}, codTag),
        h('td', { class: 'mono', text: fmt(o.measuredTons['氨氮'], 4) }),
        h('td', {}, ammTag)
      ]));
    });
    return h('table', { class: 'mini-table' }, [
      h('thead', {}, h('tr', {}, [
        h('th', { text: '排放口（层级）' }), h('th', { text: '类型' }), h('th', { text: '状态' }),
        h('th', { text: 'COD 实测(吨)' }), h('th', { text: 'COD 判定' }),
        h('th', { text: '氨氮 实测(吨)' }), h('th', { text: '氨氮 判定' })
      ])),
      tb
    ]);
  }

  function diffSourceNote(pr, mt) {
    var t = pr.rows[mt];
    var dups = (pr.outlets || []).filter(function (o) { return o.basis[mt] === 'duplicated'; });
    var falls = (pr.outlets || []).filter(function (o) { return o.basis[mt] === 'fallback'; });
    var nodes = [
      h('div', {}, [
        h('b', { text: mt + '　' }),
        '平铺 ', fmt(t.flatTotalTons, 4), ' → 去重 ', fmt(t.deduplicatedTotalTons, 4), ' 吨；重复差额 ',
        h('b', { class: t.doubleCountedTons ? 'num-danger' : 'num-ok', text: fmt(t.doubleCountedTons, 4) }), ' 吨'
      ])
    ];
    if (dups.length) {
      nodes.push(h('div', { class: 'hint', text: '差额来自车间排口同股水重复计量：' +
        dups.map(function (o) { return o.code + ' ' + o.name; }).join('、') +
        '（总排口已计量，按总排口口径只计一次，故扣减其 ' + fmt(t.doubleCountedTons, 4) + ' 吨）。' }));
    }
    if (falls.length) {
      nodes.push(h('div', { class: 'hint', text: '上级缺测下取：' +
        falls.map(function (o) { return o.code + ' ' + o.name; }).join('、') +
        '（其总排口当月无有效计量，按下级实测合计计入，不与其他排口重复）。' }));
    }
    if (!dups.length && !falls.length) nodes.push(h('div', { class: 'hint', text: '本月无层级重叠计量，平铺与去重相等。' }));
    nodes.push(h('div', { class: 'hint' }, [
      t.matched ? h('span', { class: 'num-ok', text: '逐排口明细相加 ' + fmt(t.countedDetailTons, 4) + ' = 去重后合计，核对一致。' })
                : h('span', { class: 'num-danger', text: '明细相加与层级汇总不符，请检查层级关系与缺测。' })
    ]));
    return h('div', { class: 'diff-note' }, nodes);
  }

  async function renderReconcile() {
    if (!reconcileState.month) reconcileState.month = state.month;
    var f = clear(document.getElementById('filters-reconcile'));
    var mi = h('input', { type: 'month' });
    mi.value = reconcileState.month;
    mi.addEventListener('change', function () { reconcileState.month = mi.value; renderReconcile(); });
    f.appendChild(h('div', { class: 'filter-box' }, [
      h('div', { class: 'filter-title', text: '层级核对' }),
      h('div', { class: 'field' }, [h('label', { text: '月份' }), mi]),
      h('div', { class: 'field' }, [h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: '重新核对', onclick: function () { renderReconcile(); } })])
    ]));

    var c = clear(document.getElementById('content-reconcile'));
    var data;
    try { data = await api('GET', '/api/reconcile' + qs({ month: reconcileState.month })); }
    catch (e) { showError(e); c.appendChild(h('div', { class: 'empty', text: '加载失败：' + e.message })); return; }

    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [h('h2', { text: '总量口径（去重规则）' })]),
      h('div', { class: 'card-body' }, [
        h('div', { class: 'section-note basis-rule', text: data.basisRule }),
        h('div', { class: 'section-note', text: '“平铺合计”把所有排口实测直接相加（含重复）；“去重后合计”是单位/集团上报与横向比较口径；“重复差额 = 平铺合计 − 去重后合计”，即车间排口与总排口重复计量的那一股水；“逐排口明细相加”只把判定为计入的排口实测相加，必须等于去重后合计、差额为 0 才算核对通过。' })
      ])
    ]));

    c.appendChild(h('div', { class: 'card' }, [
      h('div', { class: 'card-head' }, [
        h('h2', { text: '集团级一键核对' }),
        h('span', { class: 'sub', text: '月份 ' + data.month + ' · 共 ' + data.plants.length + ' 家单位（单位级核对见下方各单位）' })
      ]),
      h('div', { class: 'table-wrap' }, reconcileTotalsTable(data.totals))
    ]));

    data.plants.forEach(function (pr) {
      var allMatched = ['COD', '氨氮'].every(function (mt) { return pr.rows[mt].matched; });
      c.appendChild(h('div', { class: 'card' }, [
        h('div', { class: 'card-head' }, [
          h('h2', { text: pr.plant ? pr.plant.code + ' ' + pr.plant.name : '单位' }),
          h('span', { class: 'tag ' + (allMatched ? 'tag-ok' : 'tag-danger'),
            text: allMatched ? '明细相加 = 层级汇总 · 核对一致' : '核对不一致' })
        ]),
        h('div', { class: 'card-body' }, [
          h('div', { class: 'diff-grid' }, [diffSourceNote(pr, 'COD'), diffSourceNote(pr, '氨氮')]),
          h('div', { class: 'table-wrap' }, reconcileOutletTable(pr))
        ])
      ]));
    });
  }

  /* ================= 设置 ================= */
  function openSettings() {
    var s = state.settings || {};
    var fields = [
      { name: 'oxygenBaseline', label: '基准氧含量', type: 'number' },
      { name: 'rangeMax', label: '量程上限', type: 'number' },
      { name: 'maxImputeHoursPerDay', label: '单日补录上限（小时）', type: 'number' },
      { name: 'codDailyLimit', label: 'COD 日限值', type: 'number' },
      { name: 'ammoniaDailyLimit', label: '氨氮日限值', type: 'number' },
      { name: 'hourlyExceedCountLimit', label: '小时超标次数', type: 'number' },
      { name: 'annualPermitCodTons', label: '年许可 COD（吨）', type: 'number' },
      { name: 'annualPermitAmmoniaTons', label: '年许可氨氮（吨）', type: 'number' }
    ];
    var form = buildForm(fields, s);
    var save = h('button', { type: 'button', class: 'btn btn-accent', text: '保存设置' });
    save.addEventListener('click', function () {
      var raw = collectForm(form);
      var payload = {};
      Object.keys(raw).forEach(function (k) {
        var n = Number(raw[k]);
        payload[k] = isFinite(n) && raw[k] !== '' ? n : raw[k];
      });
      api('PATCH', '/api/settings', payload).then(function (res) {
        state.settings = res;
        if (state.summary) state.summary.settings = res;
        closeModal();
        toast('设置已保存');
        switchView(state.view);
      }).catch(showError);
    });
    openModal('设置', form, [
      h('button', { type: 'button', class: 'btn btn-ghost', text: '取消', onclick: closeModal }), save
    ]);
  }

  /* ================= 初始化 ================= */
  document.querySelectorAll('#tabs .tab').forEach(function (t) {
    t.addEventListener('click', function () { switchView(t.dataset.view); });
  });
  document.getElementById('settingsBtn').addEventListener('click', openSettings);

  async function init() {
    try {
      await loadAll();
      document.getElementById('todayText').textContent = state.today || '—';
      switchView('overview');
    } catch (e) {
      showError(e);
      document.getElementById('todayText').textContent = '—';
    }
  }
  init();
})();
