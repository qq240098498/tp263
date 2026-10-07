// 一次性补数：车间排口挂总排口（可多级）的演示数据。
// 场景：
//  - 青岭化工：总排口 PK-01 下挂一车间 PK-05、二车间 PK-06（同股水在总排口与车间排口都计量，去重后只取总排口）
//  - 白河电镀：总排口 PK-03 下挂电镀车间 PK-07
//  - 云岭造纸：新线总排口 PK-08 监测仪检修本月无数，下挂制浆二车间 PK-09 有计量（上级缺测，逐级下取）
// 数据覆盖 2026-09-08 ~ 2026-09-15 的逐小时 COD/氨氮/流量/氧含量。
// 幂等：按编码判重，重复执行不会产生重复数据。
const fs = require('fs');
const path = require('path');
const store = require('../server/store');

const dataFile = path.join(__dirname, '..', 'data', 'db.json');
const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const DAYS = ['08', '09', '10', '11', '12', '13', '14', '15'];

function nextId(prefix, list) { return store.nextId(prefix, list); }

const outletDefs = [
  { code: 'PK-05', name: '青岭一车间废水排口', plantId: 'pt-0001', parentCode: 'PK-01', type: '一般排放口', status: '运行' },
  { code: 'PK-06', name: '青岭二车间废水排口', plantId: 'pt-0001', parentCode: 'PK-01', type: '一般排放口', status: '运行' },
  { code: 'PK-07', name: '白河电镀车间排口', plantId: 'pt-0002', parentCode: 'PK-03', type: '一般排放口', status: '运行' },
  { code: 'PK-08', name: '云岭造纸新线总排口', plantId: 'pt-0003', parentCode: null, type: '主要排放口', status: '停用', remark: '总排口监测仪检修，2026-09 暂由下级车间排口计量' },
  { code: 'PK-09', name: '云岭制浆二车间排口', plantId: 'pt-0003', parentCode: 'PK-08', type: '一般排放口', status: '停用', remark: '随厂停产；本月有间歇排水计量' },
];

const METRIC_DEFS = [
  { metric: 'COD', base: 62, amp: 9, min: 40 },
  { metric: '氨氮', base: 8.4, amp: 1.1, min: 5 },
  { metric: '流量', base: 460, amp: 60, min: 200 },
  { metric: '氧含量', base: 12, amp: 0.6, min: 9 },
];
// 各车间排口的量级微调（相对基数的系数）
const OUTLET_SCALE = { 'PK-05': 1.0, 'PK-06': 0.92, 'PK-07': 1.35, 'PK-09': 0.7 };

let addedOutlets = 0;
let addedDevices = 0;
let addedReadings = 0;

for (const def of outletDefs) {
  if (data.outlets.some((o) => o.code === def.code)) continue;
  const parentId = def.parentCode ? data.outlets.find((o) => o.code === def.parentCode).id : null;
  const outlet = {
    id: nextId('ol', data.outlets),
    code: def.code,
    name: def.name,
    plantId: def.plantId,
    parentId,
    type: def.type,
    status: def.status,
    remark: def.remark || '',
  };
  data.outlets.push(outlet);
  addedOutlets += 1;
  if (def.code === 'PK-08') continue; // 总排口本月无数，演示逐级下取

  const scale = OUTLET_SCALE[def.code] || 1;
  const devByMetric = {};
  for (const md of METRIC_DEFS) {
    const device = {
      id: nextId('dv', data.devices),
      code: 'SB-' + String(data.devices.length + 1).padStart(2, '0'),
      outletId: outlet.id,
      metric: md.metric,
      model: '在线-' + md.metric,
      status: '正常',
      calibratedUntil: '2026-12-31',
      remark: '',
    };
    data.devices.push(device);
    devByMetric[md.metric] = device;
    addedDevices += 1;
  }
  for (const day of DAYS) {
    for (let h = 0; h < 24; h += 1) {
      const at = '2026-09-' + day + ' ' + String(h).padStart(2, '0') + ':00:00';
      for (const md of METRIC_DEFS) {
        const wave = ((h + day.length + day.charCodeAt(1)) % 5) - 2; // -2..2，确定性波动
        let value;
        if (md.metric === '流量') value = Math.round(md.base * scale + wave * (md.amp * scale) / 2);
        else if (md.metric === '氧含量') value = Number((md.base + wave * 0.12).toFixed(1));
        else if (md.metric === '氨氮') value = Number((md.base * scale + wave * 0.18).toFixed(1));
        else value = Math.round(md.base * scale + wave * (md.amp / 2));
        if (value < md.min) value = md.min;
        data.readings.push({
          id: nextId('rd', data.readings),
          outletId: outlet.id,
          deviceId: devByMetric[md.metric].id,
          metric: md.metric,
          at,
          value,
          flag: '有效',
          source: '自动',
          operator: '',
          remark: '',
        });
        addedReadings += 1;
      }
    }
  }
}

fs.writeFileSync(dataFile, JSON.stringify(data, null, 2), 'utf8');
console.log('新增排放口', addedOutlets, '台设备', addedDevices, '条读数', addedReadings);
console.log('当前排放口', data.outlets.length, '设备', data.devices.length, '读数', data.readings.length);
