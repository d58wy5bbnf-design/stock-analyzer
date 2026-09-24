const FUGLE_BASE="https://api.fugle.tw/marketdata/v1.0/stock";

function setCors(res){
res.setHeader("Access-Control-Allow-Origin","*");
res.setHeader("Access-Control-Allow-Methods","GET, OPTIONS");
res.setHeader("Access-Control-Allow-Headers","Content-Type");
}

function send(res,status,data){
return res.status(status).json(data);
}

function num(v){
var n=Number(v);
return Number.isFinite(n)?n:null;
}

function normalizeSymbol(v){
return String(v||"").trim().toUpperCase();
}

function normalizeTimeframe(v){
var tf=String(v||"5").trim().toLowerCase();

var map={
"1":"1m","1m":"1m",
"3":"3m","3m":"3m",
"5":"5m","5m":"5m",
"10":"10m","10m":"10m",
"15":"15m","15m":"15m",
"30":"30m","30m":"30m",
"60":"60m","60m":"60m","1h":"60m",
"2h":"2h",
"4h":"4h",
"6h":"6h",
"12h":"12h"
};

return map[tf]||"5m";
}

function nativeTimeframe(tf){
return({
"1m":"1",
"3m":"3",
"5m":"5",
"10m":"10",
"15m":"15",
"30m":"30",
"60m":"60"
})[tf]||null;
}

function historyDaysFor(tf){
return({
"1m":30,
"3m":60,
"5m":90,
"10m":180,
"15m":180,
"30m":365,
"60m":365
})[tf]||365;
}

function taipeiParts(timestamp){
var parts=new Intl.DateTimeFormat("en-CA",{
timeZone:"Asia/Taipei",
year:"numeric",
month:"2-digit",
day:"2-digit",
hour:"2-digit",
minute:"2-digit",
hourCycle:"h23"
}).formatToParts(new Date(timestamp));

var r={};

for(var p of parts){
if(p.type!=="literal")r[p.type]=p.value;
}

return{
year:+r.year,
month:+r.month,
day:+r.day,
hour:+r.hour,
minute:+r.minute
};
}

function taipeiDateString(date){
return new Intl.DateTimeFormat("en-CA",{
timeZone:"Asia/Taipei",
year:"numeric",
month:"2-digit",
day:"2-digit"
}).format(date);
}

function addDaysTaipeiString(days){
return taipeiDateString(
new Date(Date.now()+days*86400000)
);
}

function timestampOf(c){
var raw=
c.date??
c.time??
c.timestamp??
c.datetime??
c.at;

if(raw==null)return null;

if(typeof raw==="number"&&raw>1e12)return raw;
if(typeof raw==="number"&&raw>1e9)return raw*1000;

var x=new Date(raw).getTime();

return Number.isFinite(x)?x:null;
}

function normalizeCandle(c){
var timestamp=timestampOf(c);

return{
timestamp,
time:Number.isFinite(timestamp)
?new Date(timestamp).toISOString()
:null,
open:num(c.open),
high:num(c.high),
low:num(c.low),
close:num(c.close),
volume:num(c.volume)||0,
average:num(c.average)
};
}

function normalizeCandles(a){
if(!Array.isArray(a))return[];

return a
.map(normalizeCandle)
.filter(x=>
Number.isFinite(x.timestamp)&&
x.open!=null&&
x.high!=null&&
x.low!=null&&
x.close!=null
)
.sort((a,b)=>a.timestamp-b.timestamp);
}

async function fugleRequest(url,key){
var r=await fetch(url,{
headers:{
"X-API-KEY":key,
"Accept":"application/json"
},
cache:"no-store"
});

var text=await r.text();
var raw=null;

try{
raw=JSON.parse(text);
}catch(e){}

if(!r.ok){
var error=new Error(
raw?.message||
raw?.error||
text||
"Fugle HTTP "+r.status
);

error.status=r.status;
throw error;
}

return raw;
}

async function fetchIntraday(symbol,timeframe,key){
var url=
FUGLE_BASE+
"/intraday/candles/"+
encodeURIComponent(symbol)+
"?timeframe="+
encodeURIComponent(timeframe)+
"&sort=asc";

var raw=await fugleRequest(url,key);

return normalizeCandles(raw?.data||[]);
}

async function fetchHistoricalOnce(symbol,timeframe,key,days){
var from=addDaysTaipeiString(-days);
var to=addDaysTaipeiString(0);

var url=
FUGLE_BASE+
"/historical/candles/"+
encodeURIComponent(symbol)+
"?timeframe="+
encodeURIComponent(timeframe)+
"&from="+encodeURIComponent(from)+
"&to="+encodeURIComponent(to)+
"&fields=open%2Chigh%2Clow%2Cclose%2Cvolume%2Caverage"+
"&sort=asc";

var raw=await fugleRequest(url,key);

return normalizeCandles(raw?.data||[]);
}

async function fetchHistoricalFlexible(symbol,timeframe,key,preferredDays){
var attempts=[
preferredDays,
Math.min(preferredDays,180),
Math.min(preferredDays,90),
Math.min(preferredDays,30),
7
];

attempts=[...new Set(attempts)]
.filter(x=>x>0);

var lastError=null;

for(var days of attempts){
try{
var candles=
await fetchHistoricalOnce(
symbol,
timeframe,
key,
days
);

return{
candles,
days
};

}catch(e){
lastError=e;

if(e.status===404){
continue;
}
}
}

if(lastError&&lastError.status!==404){
throw lastError;
}

return{
candles:[],
days:0
};
}

function mergeCandles(a,b){
var map=new Map();

for(var x of a){
map.set(x.timestamp,x);
}

for(var x of b){
map.set(x.timestamp,x);
}

return [...map.values()]
.sort((x,y)=>x.timestamp-y.timestamp);
}

function sessionDateKey(ts){
var p=taipeiParts(ts);

return(
p.year+"-"+
String(p.month).padStart(2,"0")+"-"+
String(p.day).padStart(2,"0")
);
}

function sessionMinute(ts){
var p=taipeiParts(ts);
return p.hour*60+p.minute;
}

function aggregateSessionCandles(candles,minutes){
var buckets=new Map();
var START=9*60;

for(var c of candles){
var minute=sessionMinute(c.timestamp);

if(minute<START)continue;

var index=
Math.floor(
(minute-START)/minutes
);

var key=
sessionDateKey(c.timestamp)+
"|"+index;

if(!buckets.has(key)){
buckets.set(key,{
timestamp:c.timestamp,
time:c.time,
open:c.open,
high:c.high,
low:c.low,
close:c.close,
volume:+c.volume||0
});

continue;
}

var x=buckets.get(key);

x.high=Math.max(x.high,c.high);
x.low=Math.min(x.low,c.low);
x.close=c.close;
x.volume+=+c.volume||0;
}

return [...buckets.values()]
.sort((a,b)=>a.timestamp-b.timestamp);
}

async function getNative(symbol,tf,key){
var native=nativeTimeframe(tf);

var [
historical,
intraday
]=await Promise.all([
fetchHistoricalFlexible(
symbol,
native,
key,
historyDaysFor(tf)
),
fetchIntraday(
symbol,
native,
key
).catch(()=>[])
]);

return{
candles:mergeCandles(
historical.candles,
intraday
),
historicalCount:historical.candles.length,
intradayCount:intraday.length,
historyDays:historical.days
};
}

async function getHourly(symbol,tf,key){
var intervals={
"2h":120,
"4h":240,
"6h":360,
"12h":720
};

var [
historical,
intraday
]=await Promise.all([
fetchHistoricalFlexible(
symbol,
"60",
key,
365
),
fetchIntraday(
symbol,
"60",
key
).catch(()=>[])
]);

var merged=
mergeCandles(
historical.candles,
intraday
);

return{
candles:
aggregateSessionCandles(
merged,
intervals[tf]
),
historicalCount:historical.candles.length,
intradayCount:intraday.length,
historyDays:historical.days
};
}

function buildStats(candles){
var latest=candles.at(-1);
var previous=candles.length>1
?candles.at(-2)
:null;

var high=-Infinity;
var low=Infinity;
var volume=0;

for(var x of candles){
if(x.high>high)high=x.high;
if(x.low<low)low=x.low;
volume+=Number(x.volume)||0;
}

var change=null;

if(previous&&previous.close){
change=
(latest.close-previous.close)/
previous.close*100;
}

return{
latest,
previous,
latestChangePercent:change,
high,
low,
totalVolume:volume
};
}

export default async function handler(req,res){
setCors(res);

if(req.method==="OPTIONS"){
return res.status(204).end();
}

if(req.method!=="GET"){
return send(res,405,{
ok:false,
error:"Method not allowed"
});
}

var key=process.env.FUGLE_API_KEY;

if(!key){
return send(res,500,{
ok:false,
error:"Vercel 尚未設定 FUGLE_API_KEY"
});
}

var symbol=
normalizeSymbol(req.query.symbol);

var timeframe=
normalizeTimeframe(req.query.timeframe);

if(!symbol){
return send(res,400,{
ok:false,
error:"缺少股票代號"
});
}

if(!/^[0-9A-Z]{4,10}$/.test(symbol)){
return send(res,400,{
ok:false,
error:"股票代號格式錯誤"
});
}

try{
var result=
nativeTimeframe(timeframe)
?await getNative(symbol,timeframe,key)
:await getHourly(symbol,timeframe,key);

var candles=result.candles;

if(!candles.length){
return send(res,502,{
ok:false,
source:"Fugle",
symbol,
timeframe,
error:"目前沒有可用 K 棒資料"
});
}

var stats=buildStats(candles);

res.setHeader(
"Cache-Control",
"no-store, no-cache, must-revalidate, proxy-revalidate"
);

res.setHeader("Pragma","no-cache");
res.setHeader("Expires","0");

return send(res,200,{
ok:true,
platform:"妖子平台 4.5",
source:"Fugle MarketData",
sourceType:"Historical + Intraday Candles",
market:"TW",
symbol,
timeframe,
count:candles.length,
historicalCount:result.historicalCount,
intradayCount:result.intradayCount,
historyDays:result.historyDays,
latest:stats.latest,
previous:stats.previous,
latestChangePercent:stats.latestChangePercent,
high:stats.high,
low:stats.low,
totalVolume:stats.totalVolume,
candles,
updatedAt:new Date().toISOString(),
notice:"歷史 K + 今日盤中 K 已合併"
});

}catch(e){
console.error("妖子平台 kbar error:",e);

return send(
res,
e?.status||500,
{
ok:false,
source:"Fugle",
symbol,
timeframe,
error:e?.message||"取得 K 棒失敗"
}
);
}
}
