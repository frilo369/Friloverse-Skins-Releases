import test from 'node:test';
import assert from 'node:assert/strict';
import {LEGACY_STEALTH,PARTY_COMPATIBILITY,isStealthMark,markVersion,newerVersion,relayVersion,versionMark} from '../src/party-version.mjs';
import {normalizePartyVersion} from '../src/fryilo-party/shared/party-version.mjs';
import {parseClientMessage,supportsHostControls} from '../src/fryilo-party/party-relay/src/protocol.mjs';

test('version tags isolate releases and fit the relay refusal close reason',()=>{
  const a=relayVersion('0.2.0'),b=relayVersion('1000.1000.1000-very-long-release-name');
  assert.notEqual(a,b);assert.equal(a,relayVersion('0.2.0'));
  assert.equal(normalizePartyVersion(a),a);assert.equal(supportsHostControls(a),true);
  const reason=`This party uses FrYiLoCo ${a}, and you have ${b}. Everyone in a party needs the same version.`;
  assert.ok(Buffer.byteLength(reason)<=123);
});

test('the tag the relay sees is a valid one',()=>{
  const tag=relayVersion(PARTY_COMPATIBILITY);
  assert.equal(normalizePartyVersion(tag),tag);assert.equal(supportsHostControls(tag),true);
});

test('a member\'s version travels in a field the deployed relay keeps',()=>{
  for(const version of ['4.5.0','5.0.0','10.12.3','0.2.0']){
    for(const stealth of [false,true]){
      const db=versionMark(version,{stealth});
      const parsed=parseClientMessage(JSON.stringify({type:'member-meta',app:relayVersion(PARTY_COMPATIBILITY),db}));
      assert.equal(parsed.db,db,'the relay would have dropped this');
      assert.equal(markVersion(db),version);
      assert.equal(isStealthMark(db),stealth);
    }
  }
});

test('a host on 4.4 or older still counts: its Stealth is honoured and it announces no version',()=>{
  assert.equal(isStealthMark(LEGACY_STEALTH),true);
  assert.equal(markVersion(LEGACY_STEALTH),'');
  assert.equal(markVersion(''),'');
  assert.equal(isStealthMark(''),false);
});

test('only a newer version anyone announced is offered',()=>{
  const member=version=>({db:version?versionMark(version):''});
  assert.equal(newerVersion([member('4.5.0'),member('4.6.0'),member('4.5.1')],'4.5.0'),'4.6.0');
  assert.equal(newerVersion([member('4.5.0')],'4.5.0'),'');
  assert.equal(newerVersion([member('4.4.0'),member('')],'4.5.0'),'','an older friend is not an update');
  assert.equal(newerVersion([member('4.10.0')],'4.9.0'),'4.10.0','numbers, not text');
});
