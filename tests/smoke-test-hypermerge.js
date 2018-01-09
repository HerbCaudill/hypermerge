/* global it, describe, before */

const assert = require('assert')
const Automerge = require('automerge')
const {WatchableDoc} = require('automerge')
const ram = require('random-access-memory')
const pump = require('pump')
const through2 = require('through2')
const hypermerge = require('..')

class ChangeList {
  constructor (actor, watchableDoc, feed) {
    this.actor = actor
    this.watchableDoc = watchableDoc
    this.watchableDoc.registerHandler(this.newChange.bind(this))
    this.previousDoc = this.watchableDoc.get()
    this.feed = feed
  }

  newChange (doc) {
    if (this.previousDoc) {
      const changes = Automerge.getChanges(this.previousDoc, doc)
      changes
        .filter(change => change.actor === this.actor)
        .filter(change => change.seq >= this.feed.length)
        .forEach(change => {
          const {seq} = change
          this.feed.append(change, err => {
            if (err) {
              console.error('Error ' + seq, err)
            }
            // console.log('Appended', this.feed.length)
          })
        })
    }
    this.previousDoc = this.watchableDoc.get()
  }

  applyChange (change) {
    this.watchableDoc.applyChanges([change])
  }
}

function newFeed (key) {
  const promise = new Promise((resolve, reject) => {
    const hm = hypermerge(ram, key)
    hm.on('ready', () => {
      resolve(hm)
    })
    hm.on('error', err => reject(err))
  })
  return promise
}

let aliceDoc, bobDoc
let aliceChanges, bobChanges
let aliceFeed, aliceFeedRemote
let bobFeed, bobFeedRemote
let online = true

describe('smoke test, hypermerge', () => {
  // https://github.com/inkandswitch/hypermerge/wiki/Smoke-Test

  before(async () => {
    aliceDoc = new WatchableDoc(Automerge.init('alice'))
    bobDoc = new WatchableDoc(Automerge.init('bob'))

    /* eslint-disable no-unused-vars */
    aliceFeed = (await newFeed()).source
    aliceChanges = new ChangeList('alice', aliceDoc, aliceFeed)

    bobFeed = (await newFeed()).source
    bobChanges = new ChangeList('bob', bobDoc, bobFeed)
    /* eslint-enable no-unused-vars */

    aliceFeedRemote = (await newFeed(aliceFeed.key)).source
    // console.log('Jim', aliceFeed.key, aliceFeed.writable)
    // console.log('Jim2', aliceFeedRemote.key, aliceFeedRemote.writable)
    aliceFeed.on('append', () => {
      // console.log('append alice')
    })
    let lastSeenAlice = 0
    aliceFeedRemote.on('append', err => {
      if (err) {
        console.error('append alice error', err)
      }
      // console.log('append alice remote', aliceFeedRemote.length)
    })
    aliceFeedRemote.on('sync', err => {
      if (err) {
        console.error('sync alice error', err)
        return
      }
      // console.log('sync alice remote', aliceFeedRemote.length)
      const prevLastSeenAlice = lastSeenAlice
      lastSeenAlice = aliceFeedRemote.length
      for (let i = prevLastSeenAlice + 1; i <= lastSeenAlice; i++) {
        // console.log('Fetch', i)
        aliceFeedRemote.get(i - 1, (err, change) => {
          if (err) {
            console.error('Error alice remote', i, err)
            return
          }
          // console.log('Fetched alice', i, change)
          bobChanges.applyChange(change)
        })
      }
    })

    // bobFeedRemote = await (newFeed(bobFeed.key)).source
    bobFeedRemote = (await newFeed(bobFeed.key)).source
    // console.log('Jim', bobFeed.key, bobFeed.writable)
    // console.log('Jim2', bobFeedRemote.key, bobFeedRemote.writable)
    bobFeed.on('append', () => {
      // console.log('append bob')
    })
    let lastSeenBob = 0
    bobFeedRemote.on('append', err => {
      if (err) {
        console.error('append bob error', err)
      }
      // console.log('append bob remote', bobFeedRemote.length)
    })
    bobFeedRemote.on('sync', err => {
      if (err) {
        console.error('sync bob error', err)
        return
      }
      // console.log('sync bob remote', bobFeedRemote.length)
      const prevLastSeenBob = lastSeenBob
      lastSeenBob = bobFeedRemote.length
      for (let i = prevLastSeenBob + 1; i <= lastSeenBob; i++) {
        // console.log('Fetch bob', i)
        bobFeedRemote.get(i - 1, (err, change) => {
          if (err) {
            console.error('Error bob remote', i, err)
            return
          }
          // console.log('Fetched bob', i, change)
          aliceChanges.applyChange(change)
        })
      }
    })
  })

  function goOffline () {
    // console.log('Go offline')
    online = false
  }

  function goOnline () {
    // console.log('Go online')

    // alice
    const aliceLocal = aliceFeed.replicate({live: true, encrypt: false})
    const aliceRemote = aliceFeedRemote.replicate({live: true, encrypt: false})
    pump(
      aliceLocal,
      through2(function (chunk, enc, cb) {
        // console.log('alice l --> r', chunk)
        if (online) {
          this.push(chunk)
          cb()
        } else {
          cb(new Error('Offline'))
        }
      }),
      aliceRemote,
      through2(function (chunk, enc, cb) {
        // console.log('alice l <-- r', chunk)
        if (online) {
          this.push(chunk)
          cb()
        } else {
          cb(new Error('Offline'))
        }
      }),
      aliceLocal,
      err => {
        if (err && err.message !== 'Offline') {
          console.error('Alice replicate error', err)
        }
      }
    )

    // bob
    const bobLocal = bobFeed.replicate({live: true, encrypt: false})
    const bobRemote = bobFeedRemote.replicate({live: true, encrypt: false})
    pump(
      bobLocal,
      through2(function (chunk, enc, cb) {
        // console.log('bob l --> r', chunk)
        if (online) {
          this.push(chunk)
          cb()
        } else {
          cb(new Error('Offline'))
        }
      }),
      bobRemote,
      through2(function (chunk, enc, cb) {
        // console.log('bob l <-- r', chunk)
        if (online) {
          this.push(chunk)
          cb()
        } else {
          cb(new Error('Offline'))
        }
      }),
      bobLocal,
      err => {
        if (err && err.message !== 'Offline') {
          console.error('Bob replicate error', err)
        }
      }
    )

    online = true
  }

  it('1. Both Alice and Bob start with the same blank canvas. ' +
     'Both are online.', () => {
    goOnline()

    aliceDoc.set(Automerge.change(aliceDoc.get(), 'blank canvas', doc => {
      doc.x0y0 = 'w'
      doc.x0y1 = 'w'
      doc.x1y0 = 'w'
      doc.x1y1 = 'w'
    }))
    assert.deepEqual(aliceDoc.get(), {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'w',
      x0y1: 'w',
      x1y0: 'w',
      x1y1: 'w'
    })
    bobDoc.set(Automerge.merge(bobDoc.get(), aliceDoc.get()))
    assert.deepEqual(bobDoc.get(), {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'w',
      x0y1: 'w',
      x1y0: 'w',
      x1y1: 'w'
    })
  })

  it('2. Alice makes an edit', () => {
    aliceDoc.set(Automerge.change(
      aliceDoc.get(), 'alice adds red pixel',
      doc => { doc.x0y0 = 'r' }
    ))
    assert.deepEqual(aliceDoc.get(), {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'w',
      x1y1: 'w'
    })
  })

  it(`2a. Alice's edit gets synced over to Bob's canvas`, () => {
    assert.deepEqual(bobDoc.get(), {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'w',
      x1y1: 'w'
    })
    assert.deepEqual(bobDoc.get()._conflicts, {})
  })

  it('3. Bob makes an edit', () => {
    bobDoc.set(Automerge.change(
      bobDoc.get(), 'bob adds blue pixel',
      doc => { doc.x1y1 = 'b' }
    ))
    assert.deepEqual(bobDoc.get(), {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'w',
      x1y1: 'b'
    })
  })

  it(`3a. Bob's edit gets synced to Alice's canvas`, () => {
    assert.deepEqual(aliceDoc.get(), {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'w',
      x1y1: 'b'
    })
    assert.deepEqual(aliceDoc.get()._conflicts, {})
  })

  it('4. Alice and/or Bob go offline', () => {
    goOffline()
  })

  it('5. Both Alice and Bob make edits while offline', () => {
    aliceDoc.set(Automerge.change(
      aliceDoc.get(), 'alice adds green and red pixels',
      doc => {
        doc.x1y0 = 'g'
        doc.x1y1 = 'r'
      }
    ))
    bobDoc.set(Automerge.change(
      bobDoc.get(), 'bob adds green and white pixels',
      doc => {
        doc.x1y0 = 'g'
        doc.x1y1 = 'w'
      }
    ))
    assert.deepEqual(aliceDoc.get(), {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'g',
      x1y1: 'r'
    })
    assert.deepEqual(bobDoc.get(), {
      _objectId: '00000000-0000-0000-0000-000000000000',
      x0y0: 'r',
      x0y1: 'w',
      x1y0: 'g',
      x1y1: 'w'
    })
  })

  it('6. Alice and Bob both go back online, and re-sync', done => {
    goOnline()

    // wait for sync to happen
    setTimeout(() => {
      assert.deepEqual(aliceDoc.get(), {
        _objectId: '00000000-0000-0000-0000-000000000000',
        x0y0: 'r',
        x0y1: 'w',
        x1y0: 'g',
        x1y1: 'w'
      })
      assert.deepEqual(aliceDoc.get()._conflicts, {
        x1y0: {
          alice: 'g'
        },
        x1y1: {
          alice: 'r'
        }
      })
      assert.deepEqual(bobDoc.get(), {
        _objectId: '00000000-0000-0000-0000-000000000000',
        x0y0: 'r',
        x0y1: 'w',
        x1y0: 'g',
        x1y1: 'w'
      })
      assert.deepEqual(bobDoc.get()._conflicts, {
        x1y0: {
          alice: 'g'
        },
        x1y1: {
          alice: 'r'
        }
      })
      done()
    }, 0)
  })
})