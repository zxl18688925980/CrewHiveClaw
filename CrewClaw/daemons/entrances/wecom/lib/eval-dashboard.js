'use strict';
/**
 * eval-dashboard.js — 系统评估仪表盘
 * 路由: GET /api/eval/history, GET /eval-dashboard
 * module.exports = (logger, { HOMEAI_ROOT }) => express.Router()
 */
const express = require('express');
const fs      = require('fs');
const path    = require('path');

module.exports = function createEvalDashboard(logger, { HOMEAI_ROOT }) {
  const router = express.Router();
  const app = router;  // block uses `app.get`, aliased to router

// ─── 评估仪表盘（Web Dashboard）────────────────────────────────────────────────
// 公网 URL: https://wecom.homeai-wecom-zxl.top/eval-dashboard
const EVAL_DASHBOARD_URL = 'https://wecom.homeai-wecom-zxl.top/eval-dashboard';

app.get('/api/eval/history', (req, res) => {
  const historyPath = path.join(HOMEAI_ROOT, 'Data', 'learning', 'evaluation-history.jsonl');
  const count = Math.min(parseInt(req.query.count) || 50, 200);
  if (!fs.existsSync(historyPath)) return res.json([]);
  const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(l => l.trim());
  const entries = lines.slice(-count).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  res.json(entries);
});

app.get('/eval-dashboard', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>HomeAI 系统评估仪表盘</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f0f23;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:12px}
h1{font-size:18px;text-align:center;margin-bottom:8px;color:#fff}
.subtitle{font-size:12px;text-align:center;color:#888;margin-bottom:16px}
.card{background:#1a1a2e;border-radius:10px;padding:14px;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.card h2{font-size:14px;margin-bottom:8px;color:#fff;border-bottom:1px solid #333;padding-bottom:6px}
.chart-wrap{position:relative;height:280px}
.score-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.score-item{text-align:center;padding:8px 4px;background:#16213e;border-radius:8px}
.score-item .label{font-size:11px;color:#999;margin-bottom:2px}
.score-item .value{font-size:22px;font-weight:bold}
.score-item .pass{color:#2ecc71}
.score-item .warn{color:#e67e22}
.score-item .fail{color:#e74c3c}
.bottleneck{padding:6px 10px;margin:4px 0;border-radius:6px;font-size:12px;display:flex;justify-content:space-between;align-items:center}
.bottleneck.critical{background:rgba(231,76,60,.15);border-left:3px solid #e74c3c}
.bottleneck.warning{background:rgba(230,126,34,.15);border-left:3px solid #e67e22}
.bottleneck .name{flex:1}.bottleneck .score{font-weight:bold;min-width:40px;text-align:right}
.empty{text-align:center;color:#666;padding:40px;font-size:14px}
.refresh-btn{position:fixed;bottom:20px;right:20px;width:44px;height:44px;border-radius:50%;background:#3498db;color:#fff;border:none;font-size:20px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)}
</style>
</head>
<body>
<h1>HomeAI 系统评估仪表盘</h1>
<div class="subtitle" id="lastUpdate">加载中...</div>
<div class="card"><h2>总体评分</h2><div class="score-grid" id="scoreGrid"></div></div>
<div class="card"><h2>L0-L4 趋势</h2><div class="chart-wrap"><canvas id="trendChart"></canvas></div></div>
<div class="card"><h2>子维度分布（最近一次）</h2><div class="chart-wrap"><canvas id="barChart"></canvas></div></div>
<div class="card"><h2>关键卡点</h2><div id="bottlenecks"></div></div>
<button class="refresh-btn" onclick="loadData()" title="刷新">&#x21bb;</button>
<script>
const LAYER_COLORS={L0:'#2ecc71',L1:'#3498db',L2:'#e67e22',L3:'#9b59b6',L4:'#e74c3c'};
const LAYER_NAMES={L0:'L0 Agents基础设施',L1:'L1 Agents行为质量',L2:'L2 Engineering Anything',L3:'L3 组织协作进化',L4:'L4 系统自进化'};
const PASS_TH={L0:3.0,L1:3.0,L2:2.5,L3:2.0,L4:2.0};
let trendChart=null,barChart=null;
async function loadData(){
  try{
    const r=await fetch('/api/eval/history?count=30');
    const data=await r.json();
    if(!data.length){document.getElementById('scoreGrid').innerHTML='<div class="empty">暂无评估数据，请先运行 evaluate_system</div>';return;}
    renderScoreGrid(data);
    renderTrend(data);
    renderBar(data);
    renderBottlenecks(data);
    document.getElementById('lastUpdate').textContent='最近更新: '+new Date(data[data.length-1].ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+' | 共 '+data.length+' 次评估';
  }catch(e){document.getElementById('lastUpdate').textContent='加载失败: '+e.message;}
}
function renderScoreGrid(data){
  const latest=data[data.length-1];
  const keys=['L0','L1','L2','L3','L4'];
  const avg=latest.overall||0;
  let html='<div class="score-item"><div class="label">整体均值</div><div class="value '+(avg>=3?'pass':avg>=2?'warn':'fail')+'">'+avg.toFixed(1)+'</div></div>';
  for(const k of keys){
    const s=latest[k]?.w;
    if(s==null)continue;
    const cls=s>=PASS_TH[k]?'pass':s>=PASS_TH[k]-1?'warn':'fail';
    html+='<div class="score-item"><div class="label">'+LAYER_NAMES[k]+'</div><div class="value '+cls+'">'+s.toFixed(1)+'</div></div>';
  }
  document.getElementById('scoreGrid').innerHTML=html;
}
function renderTrend(data){
  const keys=['L0','L1','L2','L3','L4'];
  const labels=data.map(e=>{try{return new Date(e.ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}catch{return'?';}});
  const datasets=keys.map(k=>({label:LAYER_NAMES[k],data:data.map(e=>e[k]?.w??null),borderColor:LAYER_COLORS[k],backgroundColor:LAYER_COLORS[k]+'33',tension:.3,pointRadius:2,borderWidth:2,spanGaps:true}));
  datasets.push({label:'整体均值',data:data.map(e=>e.overall??null),borderColor:'#fff',backgroundColor:'#ffffff22',tension:.3,pointRadius:3,borderWidth:2.5,borderDash:[6,3],spanGaps:true});
  const ctx=document.getElementById('trendChart').getContext('2d');
  if(trendChart)trendChart.destroy();
  trendChart=new Chart(ctx,{type:'line',data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#ccc',font:{size:10}}}},scales:{x:{ticks:{color:'#888',maxRotation:45,font:{size:9}},grid:{color:'#ffffff0a'}},y:{min:0,max:5.5,ticks:{color:'#888',stepSize:1},grid:{color:'#ffffff0a'}}}}});
}
function renderBar(data){
  const latest=data[data.length-1];
  const keys=['L0','L1','L2','L3','L4'];
  const names=[],scores=[],colors=[];
  for(const k of keys){
    const items=latest[k]?.items||{};
    for(const[ik,iv]of Object.entries(items)){
      if(iv?.s==null)continue;
      names.push(ik.replace(/_/g,' ').substring(0,12));
      scores.push(iv.s);
      colors.push(LAYER_COLORS[k]);
    }
  }
  const ctx=document.getElementById('barChart').getContext('2d');
  if(barChart)barChart.destroy();
  barChart=new Chart(ctx,{type:'bar',data:{labels:names,datasets:[{data:scores,backgroundColor:colors.map(c=>c+'cc'),borderColor:colors,borderWidth:1}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#888',font:{size:8},maxRotation:60},grid:{color:'#ffffff0a'}},y:{min:0,max:5.5,ticks:{color:'#888',stepSize:1},grid:{color:'#ffffff0a'}}}}});
}
function renderBottlenecks(data){
  const latest=data[data.length-1];
  const keys=['L0','L1','L2','L3','L4'];
  const items=[];
  for(const k of keys){
    const its=latest[k]?.items||{};
    for(const[ik,iv]of Object.entries(its)){
      if(iv?.s==null)continue;
      if(iv.s<PASS_TH[k])items.push({layer:k,key:ik,score:iv.s,threshold:PASS_TH[k],critical:iv.s<PASS_TH[k]-1});
    }
  }
  items.sort((a,b)=>a.score-b.score);
  const el=document.getElementById('bottlenecks');
  if(!items.length){el.innerHTML='<div style="color:#2ecc71;text-align:center;padding:12px;font-size:13px">所有子维度均达标</div>';return;}
  el.innerHTML=items.slice(0,15).map(i=>'<div class="bottleneck '+(i.critical?'critical':'warning')+'"><span class="name">'+LAYER_NAMES[i.layer]+' · '+i.key.replace(/_/g,' ')+'</span><span class="score">'+i.s.toFixed(1)+'/'+i.threshold+'</span></div>').join('');
}
loadData();
</script>
</body>
</html>`);
});


  return router;
};
