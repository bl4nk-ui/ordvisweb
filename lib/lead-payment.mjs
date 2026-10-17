export const MAX_PAYMENT_RECEIVED_CENTS=99_999_999_999;

// Decimal text is parsed without floating-point arithmetic or locale guessing.
export function parsePaymentReceived(value){
 if(typeof value!=='string')return null;
 const match=/^(0|[1-9]\d{0,8})(?:[.,](\d{1,2}))?$/.exec(value.trim());
 if(!match)return null;
 const cents=Number(match[1])*100+Number((match[2]||'').padEnd(2,'0'));
 return Number.isSafeInteger(cents)&&cents>0&&cents<=MAX_PAYMENT_RECEIVED_CENTS?cents:null;
}
