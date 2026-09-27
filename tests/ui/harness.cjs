'use strict';
const {chromium}=require('playwright');
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const fixture=require('./fixture.cjs');
module.exports=async function harness() {
  const root=path.resolve(process.env.DRIFT_UI_DIST || path.join(__dirname,'../../dist'));
  const server=http.createServer((request,response)=>{
    const pathname=new URL(request.url,'http://localhost').pathname;
    const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':decodeURIComponent(pathname)));
    if(!file.startsWith(root+path.sep)){response.writeHead(403).end();return;}
    try{response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.png')?'image/png':'text/html');response.end(fs.readFileSync(file));}catch{response.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});}
  catch(error){server.close();throw error;}
  return {async page(mode='expanded',options={}){
    const sizes={compact:[650,540],expanded:[840,680],large:[1100,800]};const [width,height]=sizes[mode];
    const page=await browser.newPage({viewport:{width,height}});page.errors=[];page.on('pageerror',error=>page.errors.push(error.message));
    await page.addInitScript(fixture,{mode,...options});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByRole('button',{name:/^Select Studio,/}).waitFor();return page;
  },async close(){await browser.close();await new Promise(resolve=>server.close(resolve));}};
};
