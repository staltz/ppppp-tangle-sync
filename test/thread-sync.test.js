const test = require('tape')
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const SecretStack = require('secret-stack')
const caps = require('ssb-caps')
const p = require('util').promisify
const { generateKeypair } = require('./util')

const createSSB = SecretStack({ appKey: caps.shs })
  .use(require('ppppp-db'))
  .use(require('ssb-box'))
  .use(require('../lib'))

const ALICE_DIR = path.join(os.tmpdir(), 'dagsync-alice')
const BOB_DIR = path.join(os.tmpdir(), 'dagsync-bob')
const aliceKeys = generateKeypair('alice')
const bobKeys = generateKeypair('bob')

function getTexts(iter) {
  return [...iter]
    .filter((msg) => msg.metadata.group && msg.data)
    .map((msg) => msg.data.text)
}

/*
BEFORE dagsync:
```mermaid
graph TB;
  subgraph Bob
    direction TB
    rootAb[root by A]
    replyB1b[reply by B]
    replyB2b[reply by B]
    replyD1b[reply by D]
    rootAb-->replyB1b-->replyB2b & replyD1b
  end
  subgraph Alice
    direction TB
    rootAa[root by A]
    replyB1a[reply by B]
    replyB2a[reply by B]
    replyC1a[reply by C]
    rootAa-->replyB1a-->replyB2a
    rootAa-->replyC1a
  end
```

AFTER dagsync:
```mermaid
graph TB;
  subgraph Bob
    rootA[root by A]
    replyB1[reply by B]
    replyB2[reply by B]
    replyC1[reply by C]
    replyD1[reply by D]
    rootA-->replyB1-->replyB2 & replyD1
    rootA-->replyC1
  end
```
*/
test('sync a thread where both peers have portions', async (t) => {
  rimraf.sync(ALICE_DIR)
  rimraf.sync(BOB_DIR)

  const alice = createSSB({
    keys: aliceKeys,
    path: ALICE_DIR,
  })

  const bob = createSSB({
    keys: bobKeys,
    path: BOB_DIR,
  })

  await alice.db.loaded()
  const aliceGroupRec0 = await p(alice.db.group.create)({ _nonce: 'alice' })
  const aliceId = aliceGroupRec0.hash
  await p(alice.db.add)(aliceGroupRec0.msg, aliceId)

  await bob.db.loaded()
  const bobGroupRec0 = await p(bob.db.group.create)({ _nonce: 'bob' })
  const bobId = bobGroupRec0.hash
  await p(bob.db.add)(bobGroupRec0.msg, bobId)

  // Alice created Carol
  const carolKeys = generateKeypair('carol')
  const carolGroupRec0 = await p(alice.db.group.create)({
    keys: carolKeys,
    _nonce: 'carol',
  })
  const carolId = carolGroupRec0.hash

  // Alice created Dave
  const daveKeys = generateKeypair('dave')
  const daveGroupRec0 = await p(alice.db.group.create)({
    keys: daveKeys,
    _nonce: 'dave',
  })
  const daveId = daveGroupRec0.hash

  // Alice knows Bob
  await p(alice.db.add)(bobGroupRec0.msg, bobId)

  // Bob knows Alice, Carol, and Dave
  await p(bob.db.add)(aliceGroupRec0.msg, aliceId)
  await p(bob.db.add)(carolGroupRec0.msg, carolId)
  await p(bob.db.add)(daveGroupRec0.msg, daveId)

  const startA = await p(alice.db.feed.publish)({
    group: aliceId,
    type: 'post',
    data: { text: 'A' },
    keys: aliceKeys,
  })
  const rootHashA = alice.db.feed.getId(aliceId, 'post')
  const rootMsgA = alice.db.get(rootHashA)

  await p(bob.db.add)(rootMsgA, rootHashA)
  await p(bob.db.add)(startA.msg, rootHashA)

  const replyB1 = await p(bob.db.feed.publish)({
    group: bobId,
    type: 'post',
    data: { text: 'B1' },
    tangles: [startA.hash],
    keys: bobKeys,
  })

  const replyB2 = await p(bob.db.feed.publish)({
    group: bobId,
    type: 'post',
    data: { text: 'B2' },
    tangles: [startA.hash],
    keys: bobKeys,
  })
  const rootHashB = bob.db.feed.getId(bobId, 'post')
  const rootMsgB = bob.db.get(rootHashB)

  await p(alice.db.add)(rootMsgB, rootHashB)
  await p(alice.db.add)(replyB1.msg, rootHashB)
  await p(alice.db.add)(replyB2.msg, rootHashB)

  const replyC1 = await p(alice.db.feed.publish)({
    group: carolId,
    type: 'post',
    data: { text: 'C1' },
    tangles: [startA.hash],
    keys: carolKeys,
  })

  const replyD1 = await p(bob.db.feed.publish)({
    group: daveId,
    type: 'post',
    data: { text: 'D1' },
    tangles: [startA.hash],
    keys: daveKeys,
  })

  t.deepEquals(
    getTexts(alice.db.msgs()),
    ['A', 'B1', 'B2', 'C1'],
    'alice has a portion of the thread'
  )

  t.deepEquals(
    getTexts(bob.db.msgs()),
    ['A', 'B1', 'B2', 'D1'],
    'bob has another portion of the thread'
  )

  bob.tangleSync.setGoal(startA.hash, 'all')
  alice.tangleSync.setGoal(startA.hash, 'all')

  const remoteAlice = await p(bob.connect)(alice.getAddress())
  t.pass('bob connected to alice')

  bob.tangleSync.initiate()
  await p(setTimeout)(1000)
  t.pass('tangleSync!')

  t.deepEquals(
    getTexts(alice.db.msgs()),
    ['A', 'B1', 'B2', 'C1', 'D1'],
    'alice has the full thread'
  )

  t.deepEquals(
    getTexts(bob.db.msgs()),
    ['A', 'B1', 'B2', 'D1', 'C1'],
    'bob has the full thread'
  )

  await p(remoteAlice.close)(true)
  await p(alice.close)(true)
  await p(bob.close)(true)
})

test('sync a thread where initiator does not have the root', async (t) => {
  rimraf.sync(ALICE_DIR)
  rimraf.sync(BOB_DIR)

  const alice = createSSB({
    keys: aliceKeys,
    path: ALICE_DIR,
  })

  const bob = createSSB({
    keys: bobKeys,
    path: BOB_DIR,
  })

  await alice.db.loaded()
  const aliceGroupRec0 = await p(alice.db.group.create)({ _nonce: 'alice' })
  const aliceId = aliceGroupRec0.hash
  await p(alice.db.add)(aliceGroupRec0.msg, aliceId)

  await bob.db.loaded()
  const bobGroupRec0 = await p(bob.db.group.create)({ _nonce: 'bob' })
  const bobId = bobGroupRec0.hash
  await p(bob.db.add)(bobGroupRec0.msg, bobId)

  // Alice knows Bob
  await p(alice.db.add)(bobGroupRec0.msg, bobId)

  // Bob knows Alice
  await p(bob.db.add)(aliceGroupRec0.msg, aliceId)

  const rootA = await p(alice.db.feed.publish)({
    group: aliceId,
    type: 'post',
    data: { text: 'A' },
    keys: aliceKeys,
  })

  const replyA1 = await p(alice.db.feed.publish)({
    group: aliceId,
    type: 'post',
    data: { text: 'A1' },
    tangles: [rootA.hash],
    keys: aliceKeys,
  })

  const replyA2 = await p(alice.db.feed.publish)({
    group: aliceId,
    type: 'post',
    data: { text: 'A2' },
    tangles: [rootA.hash],
    keys: aliceKeys,
  })

  t.deepEquals(
    getTexts(alice.db.msgs()),
    ['A', 'A1', 'A2'],
    'alice has the full thread'
  )

  t.deepEquals(getTexts(bob.db.msgs()), [], 'bob has nothing')

  bob.tangleSync.setGoal(rootA.hash, 'all')
  // ON PURPOSE: alice does not set the goal
  // alice.tangleSync.setGoal(rootA.hash, 'all')

  const remoteAlice = await p(bob.connect)(alice.getAddress())
  t.pass('bob connected to alice')

  bob.tangleSync.initiate()
  await p(setTimeout)(1000)
  t.pass('tangleSync!')

  t.deepEquals(
    getTexts(bob.db.msgs()),
    ['A', 'A1', 'A2'],
    'bob has the full thread'
  )

  await p(remoteAlice.close)(true)
  await p(alice.close)(true)
  await p(bob.close)(true)
})

test('sync a thread where receiver does not have the root', async (t) => {
  rimraf.sync(ALICE_DIR)
  rimraf.sync(BOB_DIR)

  const alice = createSSB({
    keys: aliceKeys,
    path: ALICE_DIR,
  })

  const bob = createSSB({
    keys: bobKeys,
    path: BOB_DIR,
  })

  await alice.db.loaded()
  const aliceGroupRec0 = await p(alice.db.group.create)({ _nonce: 'alice' })
  const aliceId = aliceGroupRec0.hash
  await p(alice.db.add)(aliceGroupRec0.msg, aliceId)

  await bob.db.loaded()
  const bobGroupRec0 = await p(bob.db.group.create)({ _nonce: 'bob' })
  const bobId = bobGroupRec0.hash
  await p(bob.db.add)(bobGroupRec0.msg, bobId)

  // Alice knows Bob
  await p(alice.db.add)(bobGroupRec0.msg, bobId)

  // Bob knows Alice
  await p(bob.db.add)(aliceGroupRec0.msg, aliceId)

  const rootA = await p(alice.db.feed.publish)({
    group: aliceId,
    type: 'post',
    data: { text: 'A' },
    keys: aliceKeys,
  })

  const replyA1 = await p(alice.db.feed.publish)({
    group: aliceId,
    type: 'post',
    data: { text: 'A1' },
    tangles: [rootA.hash],
    keys: aliceKeys,
  })

  const replyA2 = await p(alice.db.feed.publish)({
    group: aliceId,
    type: 'post',
    data: { text: 'A2' },
    tangles: [rootA.hash],
    keys: aliceKeys,
  })

  t.deepEquals(
    getTexts(alice.db.msgs()),
    ['A', 'A1', 'A2'],
    'alice has the full thread'
  )

  t.deepEquals(getTexts(bob.db.msgs()), [], 'bob has nothing')

  bob.tangleSync.setGoal(rootA.hash, 'all')
  alice.tangleSync.setGoal(rootA.hash, 'all')

  const remoteBob = await p(alice.connect)(bob.getAddress())
  t.pass('alice connected to bob')

  alice.tangleSync.initiate()
  await p(setTimeout)(1000)
  t.pass('tangleSync!')

  t.deepEquals(
    getTexts(bob.db.msgs()),
    ['A', 'A1', 'A2'],
    'bob has the full thread'
  )

  await p(remoteBob.close)(true)
  await p(alice.close)(true)
  await p(bob.close)(true)
})

test('sync a thread with reactions too', async (t) => {
  rimraf.sync(ALICE_DIR)
  rimraf.sync(BOB_DIR)

  const alice = createSSB({
    keys: aliceKeys,
    path: ALICE_DIR,
  })

  const bob = createSSB({
    keys: bobKeys,
    path: BOB_DIR,
  })

  await alice.db.loaded()
  const aliceGroupRec0 = await p(alice.db.group.create)({ _nonce: 'alice' })
  const aliceId = aliceGroupRec0.hash
  await p(alice.db.add)(aliceGroupRec0.msg, aliceId)

  await bob.db.loaded()
  const bobGroupRec0 = await p(bob.db.group.create)({ _nonce: 'bob' })
  const bobId = bobGroupRec0.hash
  await p(bob.db.add)(bobGroupRec0.msg, bobId)

  // Alice knows Bob
  await p(alice.db.add)(bobGroupRec0.msg, bobId)

  // Bob knows Alice
  await p(bob.db.add)(aliceGroupRec0.msg, aliceId)

  const rootA = await p(alice.db.feed.publish)({
    group: aliceId,
    type: 'post',
    data: { text: 'A' },
    keys: aliceKeys,
  })

  const replyA1 = await p(alice.db.feed.publish)({
    group: aliceId,
    type: 'post',
    data: { text: 'A1' },
    tangles: [rootA.hash],
    keys: aliceKeys,
  })

  const replyA2 = await p(alice.db.feed.publish)({
    group: aliceId,
    type: 'post',
    data: { text: 'A2' },
    tangles: [rootA.hash],
    keys: aliceKeys,
  })

  const reactionA3 = await p(alice.db.feed.publish)({
    group: aliceId,
    type: 'reaction',
    data: { text: 'yes', link: replyA1.hash },
    tangles: [rootA.hash, replyA1.hash],
    keys: aliceKeys,
  })

  t.deepEquals(
    getTexts(alice.db.msgs()),
    ['A', 'A1', 'A2', 'yes'],
    'alice has the full thread'
  )

  t.deepEquals(getTexts(bob.db.msgs()), [], 'bob has nothing')

  bob.tangleSync.setGoal(rootA.hash, 'all')
  alice.tangleSync.setGoal(rootA.hash, 'all')

  const remoteBob = await p(alice.connect)(bob.getAddress())
  t.pass('alice connected to bob')

  alice.tangleSync.initiate()
  await p(setTimeout)(1000)
  t.pass('tangleSync!')

  t.deepEquals(
    getTexts(bob.db.msgs()),
    ['A', 'A1', 'A2', 'yes'],
    'bob has the full thread'
  )

  await p(remoteBob.close)(true)
  await p(alice.close)(true)
  await p(bob.close)(true)
})
