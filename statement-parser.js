"use strict";
/* Bank-statement parsing for Our Money. Pure functions only (no DOM, no storage),
   so the same file runs in the browser and under Node for tests.

   Two kinds of parser:
   - FNB parsers: tuned to FNB current-account and credit-card PDFs.
   - Generic parser: works on any text-based statement that prints a running
     balance (Capitec, Absa, Nedbank, Commonwealth, ...). Every row is checked
     against the running balance, and the last balance against the printed
     closing balance, so a wrong sign or a missed row is caught, not imported.

   All money is handled in whole cents (integers) to avoid floating-point drift. */

const p2=x=>String(x).padStart(2,"0");

// build a YYYY-MM-DD date, auto-correcting a swapped day/month (month can never be >12)
function mkDate(y,mo,d){mo=+mo;d=+d;if(mo>12&&d<=12){const t=mo;mo=d;d=t;}return `${y}-${p2(mo)}-${p2(d)}`;}

const MONTHS={jan:1,feb:2,mar:3,mrt:3,maa:3,apr:4,may:5,mei:5,jun:6,jul:7,aug:8,sep:9,oct:10,okt:10,nov:11,dec:12,des:12};
const cents=n=>Math.round(n*100);
const toRand=c=>c/100;

/* ---------- PDF -> text lines ---------- */
// Group text items into visual lines. Items whose baselines are within a few
// units of each other share a line (handles superscripts and slight misalignment).
function itemsToLines(items){
  const rows=[];
  items.filter(it=>it.str.trim()).sort((a,b)=>b.transform[5]-a.transform[5]).forEach(it=>{
    const y=it.transform[5],row=rows[rows.length-1];
    if(row&&Math.abs(row.y-y)<=3)row.items.push(it);else rows.push({y,items:[it]});});
  return rows.map(r=>r.items.sort((a,b)=>a.transform[4]-b.transform[4]).map(i=>i.str).join(" ").replace(/\s+/g," ").trim());
}

/* ---------- FNB (specific layouts) ---------- */
const FNB_NUM=s=>parseFloat(String(s).replace(/[ ,]/g,""));

function fnbParseCurrent(lines,full){
  const per=full.match(/Peri(?:ode|od)\s*:?\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})[\s\S]*?(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/i);
  const startMon=per?MONTHS[per[2].toLowerCase().slice(0,3)]:null,startYear=per?+per[3]:null,endYear=per?+per[6]:null;
  const yearOf=m=>startYear&&MONTHS[m]===startMon?startYear:(endYear||new Date().getFullYear());
  const tx=[];
  for(const line of lines){
    const dm=line.match(/^(\d{1,2})\s+([A-Za-z]{3})\b/);if(!dm)continue;
    const mon=dm[2].toLowerCase();if(!(mon in MONTHS))continue;
    // a row can end with an accrued bank charge after the balance ("... 66,266.82 Kt 3.30"); that figure is not part of the movement
    const bal=line.match(/^(.+?)\s+([\d,]+\.\d{2})\s*(Kt|Dt|Cr|Dr)(?:\s+[\d,]+\.\d{2})?\s*$/i);if(!bal)continue;
    const prefix=bal[1];
    const am=prefix.match(/([\d,]+\.\d{2})\s*(Kt|Dt|Cr|Dr)?\s*$/i);if(!am)continue;
    const credit=/^(kt|cr)$/i.test(am[2]||"");
    const amt=credit?Math.abs(FNB_NUM(am[1])):-Math.abs(FNB_NUM(am[1]));
    const desc=prefix.slice(0,am.index).replace(/^\d{1,2}\s+[A-Za-z]{3}\s*/,"").trim();
    // month-end fee rows carry no description on the statement
    tx.push({date:mkDate(yearOf(mon),MONTHS[mon],+dm[1]),desc:desc||"Bank charge",amt});
  }
  const op=full.match(/(?:Openingsaldo|Opening Balance)\s+([\d,]+\.\d{2})/i),cl=full.match(/(?:Afsluitingsaldo|Closing Balance)\s+([\d,]+\.\d{2})/i);
  const opening=op?FNB_NUM(op[1]):null,closing=cl?FNB_NUM(cl[1]):null;
  return fnbResult(tx,opening,closing,true);
}

function fnbParseCard(lines,full){
  const sd=full.match(/Statement Date\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/i);
  const stmtMon=sd?MONTHS[sd[2].toLowerCase()]:null,stmtYear=sd?+sd[3]:new Date().getFullYear();
  const yearOf=m=>stmtMon&&MONTHS[m]>stmtMon?stmtYear-1:stmtYear;
  const tx=[];
  for(const line of lines){
    const dm=line.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(.*?)\s*(\d{1,3}(?: \d{3})*\.\d{2})\s*(Cr)?\s*$/);
    if(!dm)continue;
    const mon=dm[2].toLowerCase();if(!(mon in MONTHS))continue;
    const amt=dm[5]==="Cr"?Math.abs(FNB_NUM(dm[4])):-Math.abs(FNB_NUM(dm[4]));
    tx.push({date:mkDate(yearOf(mon),MONTHS[mon],+dm[1]),desc:dm[3].trim(),amt});
  }
  return{tx,status:"unchecked",note:""};
}

// Current-account statements can be checked: opening + movements = closing.
function fnbResult(tx,opening,closing,checkable){
  if(!checkable||opening==null||closing==null)return{tx,status:"unchecked",note:""};
  const sum=tx.reduce((a,x)=>a+x.amt,0);
  return Math.abs(opening+sum-closing)<0.02
    ?{tx,status:"reconciled",note:"Balanced: the transactions add up to the statement's closing balance."}
    :{tx,status:"mismatch",note:"Doesn't fully reconcile. Worth a quick check after importing."};
}

/* ---------- Discovery Bank cards (no running balance: checked against opening and closing) ---------- */
// Rows look like "6 Nov 2021 ***9778 POS Purchase CLICKS PADDOCKS - R95.00". A leading minus means money out.
const DISC_ROW=/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(.*?)\s*(-\s*)?R\s?(\d{1,3}(?:[ ,]\d{3})*\.\d{2})\s*$/;
const DISC_BAL=label=>new RegExp(label+" balance on\\s+\\d{1,2}\\s+[A-Za-z]+\\s+\\d{4}\\s+(-\\s*)?R\\s?(\\d{1,3}(?:[ ,]\\d{3})*\\.\\d{2})","i");
function discoveryParse(lines,full){
  const cents=(neg,text)=>(neg?-1:1)*Math.round(parseFloat(text.replace(/[\s,]/g,""))*100);
  const tx=[];
  for(const line of lines){
    const m=DISC_ROW.exec(line);if(!m)continue;
    const mon=MONTHS[m[2].toLowerCase()];if(!mon)continue;
    const desc=m[4].replace(/^\*{3}\d{4}\s+/,"").replace(/\s+/g," ").trim();
    tx.push({date:mkDate(m[3],mon,+m[1]),desc,amt:cents(!!m[5],m[6])/100});
  }
  const op=DISC_BAL("Opening").exec(full),cl=DISC_BAL("Closing").exec(full);
  const name=(full.match(/Discovery\s+(\w+)\s+Card/i)||[])[1];
  const label=name?`Discovery ${name} card`:"Discovery card";
  if(!op||!cl)return{tx,status:"unchecked",note:"",label};
  const opening=cents(!!op[1],op[2]),closing=cents(!!cl[1],cl[2]);
  const sum=tx.reduce((a,t)=>a+Math.round(t.amt*100),0);
  return opening+sum===closing
    ?{tx,status:"reconciled",note:"Balanced: the opening balance plus the transactions equals the closing balance.",label}
    :{tx,status:"mismatch",note:`Doesn't reconcile: opening ${toRand(opening).toFixed(2)} plus transactions ${toRand(sum).toFixed(2)} is ${toRand(opening+sum).toFixed(2)}, but the statement's closing balance is ${toRand(closing).toFixed(2)}.`,label};
}

/* ---------- generic (any bank with a running balance) ---------- */
// Amounts may use commas or spaces as thousands separators ("8 885.29"). The
// lookbehind stops a match starting inside a longer number such as "220215 305.76".
const MONEY_SRC="(?<!\\d)-?(?:R|\\$)?\\s?\\d{1,3}(?:[ ,]\\d{3})*\\.\\d{2}(?:\\s?(?:CR|DR|KT|DT))?";
const MONEY_RE=()=>new RegExp(MONEY_SRC,"gi");
const DATE_NUMERIC=/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})\b\s*(.*)$/;
const DATE_ISO=/^(\d{4})-(\d{2})-(\d{2})\b\s*(.*)$/;
const DATE_TEXT=/^(?:(\d{1,2})\s+)?([A-Za-z]{3})\b(?:\s+(\d{4}))?\s*(.*)$/;
const SECOND_DATE=/^\d{2}\/\d{2}\/\d{4}\s+/;  // some banks show posting and transaction dates
const PERIOD=/(?:Statement Period|Period|Periode)\s*:?\s*(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})/i;
const CLOSING_LABEL="(?:(?:closing|ending|new) balance|(?:af)?sluitingsaldo)";
const CLOSING=new RegExp(CLOSING_LABEL+"\\s+(?:op\\s+\\d{1,2}\\s+[A-Za-z]+\\s+\\d{4}\\s+(?:ZAR\\s+)?|\\d{1,2}/\\d{1,2}/\\d{2,4}\\s+)?("+MONEY_SRC+")","i");
const CLOSING_LINE=new RegExp("^"+CLOSING_LABEL,"i");
const OPENING_LINE=/^(?:opening balance|openingsaldo|balance brought forward)\b/i;
const TABLE_HEADER=/^(?!\d).*(?:date|datum).*(?:balance|saldo)/i;
const PAGE_MARKER=/\bPage \d+ of \d+\b/i;
const FURNITURE=/^(24hr|Unique Document No)/i;  // bank footer lines
const END_OF_TABLE=/^End$/;
const HEADING=/^[A-Z][A-Z &()/]+$/;
const VALUE_DATE=/Value Date:\s*\d{2}\/\d{2}\/\d{4}/;

function parseMoneyCents(text){
  const number=Math.round(parseFloat(text.replace(/[^\d.]/g,"")||"0")*100);
  return /(DR|DT)$/i.test(text.trim())||text.includes("-")?-number:number;
}

// True for dd/mm, false for mm/dd, null if no date settles it.
function detectDayFirst(lines){
  const firsts=[],seconds=[];
  for(const line of lines){const m=DATE_NUMERIC.exec(line);if(m){firsts.push(+m[1]);seconds.push(+m[2]);}}
  if(firsts.some(v=>v>12))return true;
  if(seconds.some(v=>v>12))return false;
  return null;
}

// Returns {day,month,year,rest} if the line starts a transaction row, else null.
// The first date is the transaction date; a second date straight after it is dropped.
function splitRowStart(line,dayFirst){
  let m=DATE_ISO.exec(line);
  if(m)return{day:+m[3],month:+m[2],year:+m[1],rest:m[4]};
  if(m=DATE_NUMERIC.exec(line)){
    const a=+m[1],b=+m[2];
    const y=+m[3]<100?2000+ +m[3]:+m[3];
    return{day:dayFirst?a:b,month:dayFirst?b:a,year:y,rest:m[4].replace(SECOND_DATE,"")};}
  if(m=DATE_TEXT.exec(line)){
    const mon=MONTHS[m[2].toLowerCase()];
    if(mon)return{day:m[1]?+m[1]:null,month:mon,year:m[3]?+m[3]:null,rest:m[4]};}
  return null;
}

const cleanDescription=parts=>parts.join(" ").split(/\s+/).join(" ").replace(VALUE_DATE,"").trim();

// Throws an Error with a plain-English message if the statement can't be trusted.
function parseGenericText(text,opts={}){
  const lines=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const dayFirst=opts.dayFirst??detectDayFirst(lines)??true;  // ambiguous dates: assume day first

  const period=PERIOD.exec(text);
  let year=period?+period[3]:null,lastMonth=period?MONTHS[period[2].toLowerCase()]:null,lastDay=null;

  const rows=[];let inTable=false,current=null;
  for(const line of lines){
    if(TABLE_HEADER.test(line)){inTable=true;current=null;continue;}
    if(!inTable)continue;
    if(PAGE_MARKER.test(line)||FURNITURE.test(line)){current=null;continue;}  // never part of a description
    if(END_OF_TABLE.test(line)||CLOSING_LINE.test(line)){inTable=false;current=null;continue;}
    if(OPENING_LINE.test(line)){  // opening balance printed on its own line, with no date
      const m=[...line.matchAll(MONEY_RE())].pop();
      if(m){current={date:null,description:["Opening balance"],amounts:[m[0]]};rows.push(current);}
      continue;}

    const start=splitRowStart(line,dayFirst);
    if(start){
      const day=start.day??lastDay;
      if(day==null)throw new Error("A row has no day and nothing above it to copy: "+line);
      if(start.year!=null)year=start.year;
      else if(year==null)throw new Error("Can't tell which year this statement is for.");
      else if(lastMonth!=null&&start.month<lastMonth)year+=1;  // yearless statement rolled into the next year
      const found=[...start.rest.matchAll(MONEY_RE())];
      // The last two amounts are the transaction and the balance. Anything before
      // them is description, even if it contains a figure such as "(R50.00)".
      const descEnd=found.length>=2?found[found.length-2].index:(found.length?found[0].index:start.rest.length);
      current={date:mkDate(year,start.month,day),description:[start.rest.slice(0,descEnd)],amounts:found.map(f=>f[0])};
      rows.push(current);
      lastDay=day;lastMonth=start.month;
    }else if(HEADING.test(line)){inTable=false;current=null;}  // e.g. CHECKS or DAILY BALANCE SUMMARY
    else if(current)current.description.push(line);
  }

  // Some banks mark money out with a minus sign, which lets the first row work out
  // the opening balance when the statement doesn't print one.
  const signed=rows.some(r=>r.amounts.length>=2&&r.amounts[r.amounts.length-2].startsWith("-"));

  let opening=null,balance=null;const tx=[];
  for(const row of rows){
    const desc=cleanDescription(row.description);
    if(row.amounts.length===1&&/balance/i.test(desc)){balance=opening=parseMoneyCents(row.amounts[0]);continue;}  // opening balance line
    if(!row.amounts.length)continue;  // notice with no money movement
    if(row.amounts.length<2)throw new Error("No balance on the line for: "+desc);

    const amount=Math.abs(parseMoneyCents(row.amounts[row.amounts.length-2]));
    const newBalance=parseMoneyCents(row.amounts[row.amounts.length-1]);
    if(balance==null){
      if(!signed)throw new Error("No opening balance found, so I can't check which rows are money in or out.");
      balance=opening=row.amounts[row.amounts.length-2].startsWith("-")?newBalance+amount:newBalance-amount;
    }
    let value;
    if(balance-amount===newBalance)value=-amount;
    else if(balance+amount===newBalance)value=amount;
    else throw new Error("The running balance doesn't add up at: "+desc);
    balance=newBalance;
    tx.push({date:row.date,desc,amt:toRand(value),balance:toRand(newBalance)});
  }
  if(!tx.length)throw new Error("No transactions found in the statement.");

  const closeMatch=CLOSING.exec(text);
  const base={tx,opening:opening==null?null:toRand(opening)};
  if(!closeMatch)return{...base,closing:toRand(balance),status:"checked",
    note:"Every row ties to the running balance. The statement prints no closing balance to compare."};
  const closing=parseMoneyCents(closeMatch[1]);
  if(closing===balance)return{...base,closing:toRand(closing),status:"reconciled",note:"Every row ties and the closing balance matches."};
  return{...base,closing:toRand(closing),status:"mismatch",
    note:`Doesn't reconcile: the transactions end at ${toRand(balance).toFixed(2)} but the statement's closing balance is ${toRand(closing).toFixed(2)}.`};
}

/* ---------- picking a parser ---------- */
// Returns {type, label, tx, status, note, ...}. Throws Error with a plain message.
function parseStatementLines(lines){
  const full=lines.join("\n");
  if(/Discovery/i.test(full)&&/Transaction timeline/i.test(full)){
    const res=discoveryParse(lines,full);
    if(res.tx.length)return{...res,type:"card"};
  }
  const isFnb=/\bFNB\b|first national bank|transaksies in rand|transactions in rand/i.test(full);
  if(isFnb){
    const isCard=!/transaksies in rand|transactions in rand/i.test(full)&&/credit card|kredietkaart|payment due date/i.test(full);
    const res=isCard?fnbParseCard(lines,full):fnbParseCurrent(lines,full);
    if(res.tx.length)return{...res,type:isCard?"card":"current",label:isCard?"FNB credit card":"FNB cheque / current account"};
  }
  const res=parseGenericText(full);
  return{...res,type:"generic",label:"Bank statement"};
}

if(typeof module!=="undefined")module.exports={mkDate,p2,itemsToLines,parseGenericText,parseStatementLines,fnbParseCurrent,fnbParseCard,detectDayFirst};
