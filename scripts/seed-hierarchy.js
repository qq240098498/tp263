// 一次性（幂等）演示数据：给青岭化工总排口 PK-01 下挂车间排口，演示层级去重。
// 用法：node scripts/seed-hierarchy.js
// 重复执行不会产生重复数据（按排放口编码/设备编号/读数键判重）。
const path = require('path');
const store = require(path.join(__dirname, '..', 'server', 'store'));

const PARENT_CODE = 'PK-01'; // 青岭化工总排口
const MONTH = '2026-09';
const DAYS = 4; // 09-01 ~ 09-04，共 96 小时

// 每个车间排口的造数参数（确定性，不用随机数）
const OUTLET_SEED = [
  {
    code: 'PK-05', name: '青岭化工一车间废水排口', parent: PARENT_CODE, deviceCodeStart: 11,
    flow: (h) => Math.round(480 + 30 * Math.sin(h * 0.13) + 4 * ((h * 7) % 5)),
    cod: (h) => Math.round(88 + 10 * Math.sin(h * 0.09) + (h % 6)),
    ammonia: (h) => Number((10.6 + 0.8 * Math.sin(h * 0.1)).toFixed(2)),
    oxygen: (h) => Number((11.8 + 0.5 * Math.sin(h * 0.2)).toFixed(2)),
    remark: '一车间生产废水，汇入总排口 PK-01',
  },
  {
    code: 'PK-06', name: '青岭化工二车间废水排口', parent: PARENT_CODE,
    flow: (h) => Math.round(420 + 25 * Math.sin(h * 0.11 + 1.7) + 3 * ((h * 5) % 5)),
    cod: (h) => Math.round(62 + 8 * Math.sin(h * 0.12 + 0.6) + (h % 5)),
    ammonia: (h) => Number((8.1 + 0.6 * Math.sin(h * 0.14 + 0.4)).toFixed(2)),
    oxygen: (h) => Number((12.2 + 0.4 * Math.cos(h * 0.19)).toFixed(2)),
    remark: '二车间生产废水，汇入总排口 PK-01',
  },
];
// 多级演示：预处理段排口挂在一车间排口 PK-05 之下，只测 COD（浓度更高，处理前）
const SECTION_SEED = {
  code: 'PK-07', name: '青岭化工一车间预处理段排口', parent: 'PK-05',
  cod: (h) => Math.round(132 + 15 * Math.sin(h * 0.07) + (h % 4)),
  remark: '一车间预处理段出水，汇入一车间排口 PK-05（多级层级演示）',
};

const METRICS = ['COD', '氨氮', '流量', '氧含量'];

function pad2(n) { return String(n).padStart(2, '0'); }
function hourAt(h) {
  const day = Math.floor(h / 24) + 1;
  const hour = h % 24;
  return MONTH + '-' + pad2(Math.min(day, DAYS)) + ' ' + pad2(hour) + ':00:00';
}

function main() {
  const data = store.load();
  const parent = data.outlets.find((o) => o.code === PARENT_CODE);
  if (!parent) throw new Error('找不到上级总排口 ' + PARENT_CODE);

  const findOutlet = (code) => data.outlets.find((o) => o.code === code);
  const ensureOutlet = (seed, directParent) => {
    let o = findOutlet(seed.code);
    if (!o) {
      o = {
        id: store.nextId('ol', data.outlets),
        code: seed.code,
        name: seed.name,
        plantId: parent.plantId,
        parentId: directParent.id,
        type: '一般排放口',
        status: '运行',
        remark: seed.remark,
      };
      data.outlets.push(o);
      console.log('新增排放口', o.code, o.name, '→ 上级', directParent.code);
    }
    return o;
  };

  const ensureDevice = (outlet, code, metric) => {
    let dv = data.devices.find((d) => d.code === code);
    if (!dv) {
      dv = {
        id: store.nextId('dv', data.devices),
        code,
        outletId: outlet.id,
        metric,
        model: '在线监测仪',
        status: '正常',
        calibratedUntil: '2027-06-30',
        remark: '',
      };
      data.devices.push(dv);
    }
    return dv;
  };

  const hasReading = (outletId, metric, at) =>
    data.readings.some((r) => r.outletId === outletId && r.metric === metric && r.at === at);

  let readingAdded = 0;
  const addSeries = (outlet, metric, valueFn) => {
    const code = 'SB-' + pad2(deviceSeq.next());
    const dv = ensureDevice(outlet, code, metric);
    for (let h = 0; h < DAYS * 24; h += 1) {
      const at = hourAt(h);
      if (hasReading(outlet.id, metric, at)) continue;
      data.readings.push({
        id: store.nextId('rd', data.readings),
        outletId: outlet.id,
        deviceId: dv.id,
        metric,
        at,
        value: valueFn(h),
        flag: '有效',
        source: '自动',
        operator: '',
        remark: '',
      });
      readingAdded += 1;
    }
  };

  // 设备编号从 SB-11 开始，避开既有 SB-01..SB-10
  let deviceNo = 10;
  const deviceSeq = { next: () => { deviceNo += 1; return deviceNo; } };

  for (const seed of OUTLET_SEED) {
    const o = ensureOutlet(seed, findOutlet(seed.parent));
    addSeries(o, 'COD', seed.cod);
    addSeries(o, '氨氮', seed.ammonia);
    addSeries(o, '流量', seed.flow);
    addSeries(o, '氧含量', seed.oxygen);
  }

  // 多级：PK-07 → PK-05，仅 COD
  const sectionOutlet = ensureOutlet(SECTION_SEED, findOutlet(SECTION_SEED.parent));
  addSeries(sectionOutlet, 'COD', SECTION_SEED.cod);

  store.save(data);
  console.log('完成：新增/确认小时值 ' + readingAdded + ' 条，当前共排放口 ' + data.outlets.length +
    ' 个、设备 ' + data.devices.length + ' 台、监测数据 ' + data.readings.length + ' 条');
  console.log('层级：PK-01 总排口 下挂 PK-05、PK-06；PK-05 下再挂 PK-07（多级）');
}

main();
