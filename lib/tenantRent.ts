export type RentRecord = { lease_id: string; amount: number; currency: string; due_date: string | null; paid_on: string | null };
export type RentState = "paid" | "overdue" | "due" | "upcoming" | "unscheduled";
export function localDateKey(date = new Date()): string { return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`; }
export function rentState(record: Pick<RentRecord,"paid_on"|"due_date">, today = localDateKey()): RentState {
 if(record.paid_on) return "paid";
 if(!record.due_date) return "unscheduled";
 if(record.due_date < today) return "overdue";
 if(record.due_date === today) return "due";
 return "upcoming";
}
export function rentSummaries(records: RentRecord[], today = localDateKey()): {leaseId:string;currency:string;overdue:number;due:number;upcoming:number;unscheduled:number}[] {
 const groups=new Map<string,{leaseId:string;currency:string;overdue:number;due:number;upcoming:number;unscheduled:number}>();
 for(const record of records){const state=rentState(record,today);if(state==="paid")continue;const key=`${record.lease_id}:${record.currency}`;let group=groups.get(key);if(!group){group={leaseId:record.lease_id,currency:record.currency,overdue:0,due:0,upcoming:0,unscheduled:0};groups.set(key,group);}const amount=Number(record.amount);if(Number.isFinite(amount))group[state]+=amount;}
 return [...groups.values()];
}
