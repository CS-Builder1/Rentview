import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { setTimeout as pause } from 'node:timers/promises';
import { disposableDatabaseTarget } from '../../scripts/db-target.mjs';

// Separate psql sessions exercise committed rows and real lock contention.
function connect(target, env) {
  const client = spawn('psql', ['-XAtq', '-v', 'ON_ERROR_STOP=1', '--dbname', target], { env, stdio: 'pipe' });
  const ended = once(client, 'close');
  const lines = createInterface({ input: client.stdout })[Symbol.asyncIterator]();
  let errors = '';
  client.stderr.on('data', chunk => { errors += chunk; });
  return {
    async sql(statement) {
      const marker = randomUUID();
      client.stdin.write(statement + '\n\\echo ' + marker + '\n');
      const result = [];
      for (;;) {
        const { value, done } = await lines.next();
        if (done) throw new Error(errors || 'Database session ended unexpectedly');
        if (value === marker) return result.join('\n');
        result.push(value);
      }
    },
    async close() {
      if (client.exitCode === null && !client.stdin.destroyed) client.stdin.end('\\q\n');
      await ended;
    },
  };
}

function actor(uid) {
  return `begin; set local statement_timeout='10s'; set local role authenticated;
    set local request.jwt.claim.sub='${uid}';
    set local request.jwt.claims='{"sub":"${uid}","role":"authenticated"}';`;
}

export async function verifyPortfolioConcurrency(raw, env) {
  const target = disposableDatabaseTarget(raw, process.env.RENTVIEW_DISPOSABLE_DATABASE);
  const [owner, next, neighbor, property, elsewhere, earlyUnit, otherUnit] = Array.from({ length: 7 }, randomUUID);
  const staff = `review-${next}@example.test`;
  const label = `portfolio-handover-${property}`;
  const db = connect(target, env);
  const writer = connect(target, env);
  const transfer = connect(target, env);
  try {
    await db.sql(`begin;
      insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values
        ('${owner}','review-${owner}@example.test',now(),'{}'),('${next}','${staff}',now(),'{}'),
        ('${neighbor}','review-${neighbor}@example.test',now(),'{}');
      insert into public.properties(id,owner_id,name) values
        ('${property}','${owner}','Transfer fixture'),('${elsewhere}','${neighbor}','Independent portfolio');
      commit;
      ${actor(owner)} select public.invite_property_manager('${property}','${staff}'); commit;
      ${actor(next)} select public.accept_manager_invitation('${property}'); commit;
      ${actor(owner)} select public.offer_portfolio_transfer('${next}'); commit;`);

    await writer.sql(`${actor(owner)}
      insert into public.units(id,property_id,owner_id,label) values('${earlyUnit}','${property}',auth.uid(),'In progress');`);
    const accepting = transfer.sql(`set application_name='${label}'; ${actor(next)}
      select public.accept_portfolio_transfer('${owner}');`);
    accepting.catch(() => {}); // The result is awaited after the writer commits.
    let waiting = false;
    const deadline = Date.now() + 6000;
    while (!waiting && Date.now() < deadline) {
      waiting = await db.sql(`select exists(select from pg_stat_activity where application_name='${label}'
        and wait_event_type='Lock' and lower(wait_event)='advisory');`) === 't';
      if (!waiting) await pause(40);
    }
    assert.ok(waiting, 'Transfer must wait for a child insert already in progress');
    await writer.sql('commit;');
    await accepting;

    // The completed transfer is still uncommitted here. Another owner can write
    // the same child table while the transferring owner receives a retry signal.
    await writer.sql(`${actor(neighbor)} set local lock_timeout='2s';
      insert into public.units(id,property_id,owner_id,label) values('${otherUnit}','${elsewhere}',auth.uid(),'Independent'); commit;`);
    await writer.sql(`${actor(owner)} set local lock_timeout='2s';
      do $$ begin
        insert into public.units(property_id,owner_id,label) values ('${property}',auth.uid(),'Concurrent');
        raise exception 'Expected the in-progress transfer to request a retry';
      exception when serialization_failure then null; end $$; commit;`);
    await transfer.sql('commit;');
    assert.equal(await db.sql(`select owner_id from public.units where id='${earlyUnit}';`), next);
    assert.equal(await db.sql(`select owner_id from public.units where id='${otherUnit}';`), neighbor);
    console.log('Passed concurrent property handover and independent child writes.');
  } finally {
    try {
      await Promise.all([writer.close(), transfer.close()]);
      await db.sql(`rollback; delete from auth.users where id in ('${owner}','${next}','${neighbor}');`);
    } finally { await db.close(); }
  }
}
