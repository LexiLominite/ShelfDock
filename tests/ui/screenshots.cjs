'use strict';
const path=require('node:path');
const fs=require('node:fs/promises');
const harness=require('./harness.cjs');
(async()=>{const app=await harness();try{
  const phase=process.argv.includes('--before')?'before':'after';
  const destination=path.resolve(__dirname,'../../docs/ui');await fs.mkdir(destination,{recursive:true});
  for(const [mode,label] of [['compact','compact'],['expanded','balanced'],['large','expanded']]){
    const page=await app.page(mode);
    await page.screenshot({path:path.join(destination,`${phase}-${label}-transfers.png`)});
    await page.getByRole('navigation',{name:'Workspace'}).getByRole('button',{name:'Clipboard',exact:true}).click();
    await page.locator('.clipboard-list [role="option"]').first().waitFor();await page.getByRole('listbox').focus();
    await page.screenshot({path:path.join(destination,`${phase}-${label}-clipboard.png`)});
    if(page.errors.length)throw new Error(page.errors.join('\n'));await page.close();
  }
  console.log(`${phase}: six fictional screenshots captured.`);
}finally{await app.close();}})().catch(error=>{console.error(error);process.exitCode=1;});
