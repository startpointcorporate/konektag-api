const error = code => ({value:{error:code}});
const valuation={type:'object',required:['currency','rate','source','date','kind'],properties:{
 currency:{type:'string'},rate:{type:'number'},source:{type:'string'},date:{type:['string','null'],format:'date-time'},kind:{type:'string',const:'INDICATIVE'}}};

export function documentWallet(paths){
 const checkout=paths['/api/pay/checkout/{token}']?.get;
 if(checkout) checkout.responses['200']={description:'Checkout et preuve de crédit Points K distincte du statut PSP',content:{'application/json':{schema:{type:'object',required:['state','pointsCreditStatus'],properties:{state:{type:'string',enum:['pending','processing','awaiting_mobile_money','paid','failed','expired','cancelled']},pointsCreditStatus:{type:'string',enum:['pending','credited','not_applicable'],description:'credited exige une acquisition achevée et une écriture crédit K confirmée dans le ledger; paid seul ne suffit pas.'}}}}}};
 const balance=paths['/api/account/balance']?.get;
 if(balance){
  balance.summary='Lire les soldes Points K';
  balance.description='Solde confirmé et disponible issus des faits wallet comptables. Les réservations sont déduites du disponible; le net en cours est séparé et ne constitue jamais un solde projeté. La valorisation est indicative.';
  balance.responses['200']={description:'Soldes wallet',content:{'application/json':{schema:{type:'object',required:['points_balance','points_reserved','points_available','points_pending_net','currency','valuation'],properties:{
   points_balance:{type:'integer'},points_reserved:{type:'integer'},points_available:{type:'integer'},points_pending_net:{type:'integer'},currency:{type:'string'},valuation}},example:{points_balance:120,points_reserved:20,points_available:100,points_pending_net:10,currency:'EUR',valuation:{currency:'EUR',rate:1,source:'static_fallback',date:null,kind:'INDICATIVE'}}}}};
  balance.responses['503']={description:'Projection wallet ou taux indisponible',content:{'application/json':{schema:{type:'object',required:['error'],properties:{error:{type:'string'}}},examples:{wallet:error('WALLET_BALANCE_UNAVAILABLE'),rate:error('EXCHANGE_RATE_UNAVAILABLE')}}}};
 }
 const history=paths['/api/account/history']?.get;
 if(history){
  history.summary='Lister les mouvements Points K';
  history.description='Historique paginé signé, lu directement dans le ledger canonique. Cashback, transferts, acquisitions, paiements et remboursements partagent les mêmes faits comptables.';
  history.responses['200']={description:'Historique wallet paginé',content:{'application/json':{schema:{type:'object',required:['items','pagination','statuses'],properties:{items:{type:'array',items:{type:'object',required:['date','type','quantityK','value','original','reference','status'],properties:{date:{type:'string',format:'date-time'},type:{type:'string'},quantityK:{type:'integer'},value:{allOf:[valuation,{type:'object',required:['amount'],properties:{amount:{type:'number'}}}]},original:{type:'object',required:['amountMinor','currency','provider'],properties:{amountMinor:{type:['integer','null']},currency:{type:['string','null']},provider:{type:['string','null']}}},reference:{type:'string'},status:{type:'string',enum:['PENDING','PROCESSING','COMPLETED','FAILED','CANCELLED']},counterparty:{type:['string','null']}}}},pagination:{type:'object',properties:{limit:{type:'integer'},offset:{type:'integer'},total:{type:'integer'}}},statuses:{type:'array',items:{type:'string'}}}}}}};
  history.responses['503']={description:'Historique ou taux indisponible; jamais converti en liste vide',content:{'application/json':{schema:{type:'object',required:['error'],properties:{error:{type:'string'}}},examples:{history:error('WALLET_HISTORY_UNAVAILABLE'),rate:error('EXCHANGE_RATE_UNAVAILABLE')}}}};
 }
 const preference=paths['/api/account/currency-preference'];
 if(preference){
  const currency={type:'string',enum:['XOF','XAF','EUR','USD','LBP','AOA','CDF','GNF']};
  const response=(schema)=>({description:'Préférence de devise',content:{'application/json':{schema}}});
  preference.get.responses['200']=response({type:'object',required:['currency','defaultCurrency','country'],properties:{currency,defaultCurrency:{type:'string'},country:{type:['string','null']}}});
  preference.put.responses['200']=response({type:'object',required:['currency'],properties:{currency}});
  for(const method of ['get','put'])preference[method].responses['503']={description:'Préférence indisponible',content:{'application/json':{schema:{type:'object',required:['error'],properties:{error:{type:'string',const:'CURRENCY_PREFERENCE_UNAVAILABLE'}}}}}};
  preference.get.summary='Lire la devise d’affichage préférée';
  preference.put.summary='Modifier la devise d’affichage préférée';
  preference.put.requestBody={required:true,content:{'application/json':{schema:{type:'object',required:['currency'],properties:{currency:{type:'string',enum:['XOF','XAF','EUR','USD','LBP','AOA','CDF','GNF']}}},example:{currency:'XAF'}}}};
 }
}
