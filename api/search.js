const https = require("https");


/*
  台股中文名稱 / 代號搜尋

  支援：

  2330
  台積電
  台積
  積電
  聯發
  鴻
  長榮

  不需要輸入完整名稱。
*/


let stockCache = null;

let cacheTime = 0;

const CACHE_MS =
6 * 60 * 60 * 1000;


/* =========================================================
   API
========================================================= */

module.exports =
async function handler(req,res){

res.setHeader(
"Access-Control-Allow-Origin",
"*"
);

res.setHeader(
"Access-Control-Allow-Methods",
"GET, OPTIONS"
);

res.setHeader(
"Cache-Control",
"public, max-age=300, s-maxage=300"
);


if(
req.method==="OPTIONS"
){

return res
.status(200)
.end();

}


try{

const q=
String(
req.query.q || ""
)
.trim()
.toLowerCase();


if(!q){

return res
.status(200)
.json({

ok:true,

items:[]

});

}


const stocks=
await getStocks();


const normalizedQuery=
normalize(q);


let result=
stocks
.map(

stock=>{

const symbol=
normalize(
stock.symbol
);

const name=
normalize(
stock.name
);


let score=0;


/*
  完整代號
*/

if(
symbol===normalizedQuery
){

score=1000;

}


/*
  代號開頭
*/

else if(
symbol.startsWith(
normalizedQuery
)
){

score=900;

}


/*
  完整中文名稱
*/

else if(
name===normalizedQuery
){

score=850;

}


/*
  中文名稱開頭

  例如：
  台積 → 台積電
  聯發 → 聯發科
*/

else if(
name.startsWith(
normalizedQuery
)
){

score=800;

}


/*
  中文名稱任意位置

  例如：
  積電 → 台積電
*/

else if(
name.includes(
normalizedQuery
)
){

score=700;

}


/*
  代號部分符合
*/

else if(
symbol.includes(
normalizedQuery
)
){

score=600;

}


return {

...stock,

score

};

}

)
.filter(
x=>x.score>0
)
.sort(

(a,b)=>{

if(
b.score!==a.score
){

return b.score-a.score;

}


return (
a.symbol.localeCompare(
b.symbol
)
);

}

)
.slice(
0,
20
)
.map(
x=>({

symbol:x.symbol,

name:x.name,

market:x.market

})
);


return res
.status(200)
.json({

ok:true,

query:q,

items:result

});


}catch(error){

console.error(
"search api error:",
error
);


return res
.status(500)
.json({

ok:false,

error:
error?.message ||
"台股搜尋資料取得失敗"

});

}

};


/* =========================================================
   Stock List
========================================================= */

async function getStocks(){

if(
stockCache &&
Date.now()-cacheTime<
CACHE_MS
){

return stockCache;

}


const all=[];


/*
  上市股票
*/

try{

const listed=
await getListedStocks();

all.push(
...listed
);

}catch(error){

console.error(
"TWSE search source error",
error
);

}


/*
  上櫃股票
*/

try{

const otc=
await getOTCStocks();

all.push(
...otc
);

}catch(error){

console.error(
"TPEX search source error",
error
);

}


/*
  如果官方來源其中一個暫時失敗，
  至少保留常用股票，
  不讓搜尋功能整個掛掉。
*/

all.push(
...fallbackStocks()
);


const map=
new Map();


for(
const stock of all
){

if(
!stock ||
!stock.symbol ||
!stock.name
)
continue;


const symbol=
String(
stock.symbol
)
.trim();


const name=
String(
stock.name
)
.trim();


if(
!/^\d{4,6}$/.test(
symbol
)
)
continue;


if(
!map.has(symbol)
){

map.set(
symbol,
{

symbol,

name,

market:
stock.market || "TW"

}
);

}

}


stockCache=
[...map.values()];


cacheTime=
Date.now();


return stockCache;

}


/* =========================================================
   TWSE 上市
========================================================= */

async function getListedStocks(){

const urls=[

"https://openapi.twse.com.tw/v1/opendata/t187ap03_L",

"https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"

];


for(
const url of urls
){

try{

const json=
await requestJSON(
url
);


if(
!Array.isArray(json)
)
continue;


const result=[];


for(
const row of json
){

const symbol=
String(

row["公司代號"] ||

row["Code"] ||

row["證券代號"] ||

""

)
.trim();


const name=
String(

row["公司簡稱"] ||

row["Name"] ||

row["證券名稱"] ||

""

)
.trim();


if(
/^\d{4,6}$/.test(
symbol
)
&&
name
){

result.push({

symbol,

name,

market:"TW"

});

}

}


if(
result.length
){

return result;

}

}catch(error){

console.error(
"TWSE URL failed:",
url,
error.message
);

}

}


return [];

}


/* =========================================================
   TPEX 上櫃
========================================================= */

async function getOTCStocks(){

const urls=[

"https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap03_O",

"https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"

];


for(
const url of urls
){

try{

const json=
await requestJSON(
url
);


if(
!Array.isArray(json)
)
continue;


const result=[];


for(
const row of json
){

const symbol=
String(

row["公司代號"] ||

row["SecuritiesCompanyCode"] ||

row["SecuritiesCompanyCode "] ||

row["股票代號"] ||

row["代號"] ||

row["Code"] ||

""

)
.trim();


const name=
String(

row["公司簡稱"] ||

row["CompanyName"] ||

row["SecuritiesCompanyName"] ||

row["股票名稱"] ||

row["名稱"] ||

row["Name"] ||

""

)
.trim();


if(
/^\d{4,6}$/.test(
symbol
)
&&
name
){

result.push({

symbol,

name,

market:"TWO"

});

}

}


if(
result.length
){

return result;

}

}catch(error){

console.error(
"TPEX URL failed:",
url,
error.message
);

}

}


return [];

}


/* =========================================================
   Fallback
========================================================= */

function fallbackStocks(){

return [

{
symbol:"2330",
name:"台積電",
market:"TW"
},

{
symbol:"2317",
name:"鴻海",
market:"TW"
},

{
symbol:"2454",
name:"聯發科",
market:"TW"
},

{
symbol:"2308",
name:"台達電",
market:"TW"
},

{
symbol:"2382",
name:"廣達",
market:"TW"
},

{
symbol:"3231",
name:"緯創",
market:"TW"
},

{
symbol:"2881",
name:"富邦金",
market:"TW"
},

{
symbol:"2882",
name:"國泰金",
market:"TW"
},

{
symbol:"2891",
name:"中信金",
market:"TW"
},

{
symbol:"2886",
name:"兆豐金",
market:"TW"
},

{
symbol:"2603",
name:"長榮",
market:"TW"
},

{
symbol:"2615",
name:"萬海",
market:"TW"
},

{
symbol:"2412",
name:"中華電",
market:"TW"
},

{
symbol:"1301",
name:"台塑",
market:"TW"
},

{
symbol:"1303",
name:"南亞",
market:"TW"
},

{
symbol:"2002",
name:"中鋼",
market:"TW"
},

{
symbol:"2303",
name:"聯電",
market:"TW"
},

{
symbol:"2357",
name:"華碩",
market:"TW"
},

{
symbol:"2379",
name:"瑞昱",
market:"TW"
},

{
symbol:"3008",
name:"大立光",
market:"TW"
},

{
symbol:"3711",
name:"日月光投控",
market:"TW"
},

{
symbol:"6505",
name:"台塑化",
market:"TW"
}

];

}


/* =========================================================
   Normalize
========================================================= */

function normalize(value){

return String(
value || ""
)
.toLowerCase()
.replace(/\s+/g,"")
.replace(/[()（）\-_.]/g,"");

}


/* =========================================================
   HTTP
========================================================= */

function requestJSON(url){

return new Promise(
(resolve,reject)=>{

let done=false;


const req=
https.get(

url,

{

headers:{

"User-Agent":
"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131 Safari/537.36",

"Accept":
"application/json,text/plain,*/*",

"Accept-Language":
"zh-TW,zh;q=0.9,en;q=0.8",

"Cache-Control":
"no-cache"

},

timeout:10000

},

response=>{

let body="";


response.setEncoding(
"utf8"
);


response.on(
"data",
chunk=>{

if(
body.length<
10*1024*1024
){

body+=chunk;

}

}
);


response.on(
"end",
()=>{

if(done)
return;


done=true;


if(
response.statusCode<200 ||
response.statusCode>=300
){

return reject(
new Error(
"HTTP "+
response.statusCode
)
);

}


try{

resolve(
JSON.parse(body)
);

}catch{

reject(
new Error(
"JSON 解析失敗"
)
);

}

}
);

}

);


req.on(
"timeout",
()=>{

if(done)
return;


done=true;


req.destroy();


reject(
new Error(
"連線逾時"
)
);

}
);


req.on(
"error",
error=>{

if(done)
return;


done=true;


reject(error);

}
);

}
);

}
