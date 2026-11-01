import {validate,normalization,modelStats} from './morph-core.js';

// Sends stored Visco-format models to the engine, including when the editor is closed.
export default function worker(connection) {
  const serial=[0,0];
  async function upload(slot,model) {
    const token=++serial[slot];
    if(!validate(model))return;
    const norm=normalization(model);
    if(!Number.isFinite(norm)||norm<=0)return;
    // Coalesce same-turn edits. One model is 14 small events, well inside the host queue.
    await Promise.resolve();
    if(serial[slot]!==token)return;
    const curves=[...model.time,...model.frequency];
    curves.forEach((curve,i)=>connection.sendEventOrValue('modelCurve',{slot,kind:i<7?0:1,index:i<7?i:i-7,positions:i<7?[...curve,...Array(8).fill(0)]:curve}));
    modelStats(model);
    connection.sendEventOrValue('modelInfo',{slot,norm,duration:model.duration,tail:model.tail});
  }
  connection.addStoredStateValueListener(({key,value})=>{
    if(key==='morphField.A')upload(0,value);
    if(key==='morphField.B')upload(1,value);
  });
  connection.requestStoredStateValue('morphField.A');
  connection.requestStoredStateValue('morphField.B');
  console.info('Morph Field worker ready.');
}
