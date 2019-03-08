# Hypermerge

Hypermerge is a proof-of-concept library for using the [Hypercore](hypercore) tools from the DAT ecosystem to enable peer to peer communication between [Automerge](automerge) data stores.

This project provides a way for applications to use datasets that are conflict-free and offline-first (thanks to CRDTs) and serverless (thanks to Hypercore/DAT).

Hypermerge doesn't deal with security or privacy directly. Due to the secure nature of the tools it is built on, a properly audited and secure version of this library would be possible in the future.


## Usage

### Basic example


```js

  import { Repo } from 'hypermerge'

  const ram = require('random-access-memory')

  // create a new repo, stored in memory 
  const repo = new Repo({ storage: ram })

  // create new document and get an identifier
  const url = repo.create({ hello: 'world' })

  // read the document once
  repo.doc(url, (doc) => {
    console.log(doc) // { hello: 'world' }
  })

  repo.change(url, (doc) => {
    // here we can treat the doc as a plain old javacript object; changes 
    // will be added to an internal append-only log and replicated to peers
    doc.foo = 'bar'
  })

  repo.doc(url, (doc) => {
    console.log(doc) // { hello: 'world', foo: 'bar' }
  })

  // log all changes to the document
  repo.watch(url, (doc) => {
    console.log(doc)
  })
```

### Replication

> TODO: explain this

```js
const Client = require('discovery-cloud-client')
const defaults = require('dat-swarm-defaults')

const client = new Client(defaults({stream: repo.stream, id: repo.id }))

repo.replicate(client)
```

### Repos on different machines

> TODO: explain this

```js
const repoA = new Repo({ storage: ram })
const repoB = new Repo({ storage: ram })

const clientA = new Client({
  id: repoA.id,
  stream: repoA.stream,
  url: "wss://discovery-cloud.glitch.me",
})

const clientB = new Client({
  id: repoB.id,
  stream: repoB.stream,
  url: "wss://discovery-cloud.glitch.me",
})

repoA.replicate(clientA)
repoB.replicate(clientB)

const docUrl = repoA.create({ numbers: [2, 3, 4]})
// in practice, docUrl would now need to be communicated to Machine B to share access to the document

// watch changes from machine A
repoA.watch(docUrl, state => {
  console.log('RepoA', state)
})

// watch changes from machine B
repoB.watch(docUrl, state => {
  console.log('RepoB', state)
})

// make two changes on machine A
repoA.change(docUrl, (state) => {
  state.numbers.push(5)
  state.foo = 'bar'
})

// make a change on machine B
repoB.change<MyDoc>(docUrl, (state) => {
  state.bar = 'foo'
})

// output on machine A:
//   { numbers: [2, 3, 4] } 
//   { numbers: [2, 3, 4, 5], foo: 'bar' }
//   { numbers: [2, 3, 4, 5], foo: 'bar' } // (local changes repeat)
//   { numbers: [2, 3, 4, 5], foo: 'bar', bar: 'foo' }

// output on machine B:
//   { numbers: [1,2,3,4,5], foo: 'bar', bar: 'foo' }

```


## API

### `new Repo([options]`)

The base object you make with hypermerge is an instance of `Repo`, which is responsible for managing a set of documents and replicating to peers.

```js
const repo = new Repo({storage: ram})
```


### `repo.create([initialState])` 

Creates a new document, optionally based on an initial value.

```js
const id = repo.create({ hello: 'world' })
```

Each document is identified by a globally unique identifier. 

### `repo.watch(id, callback)` 

Gives read-only access to a document's state as it changes. The callback you provide is fired each time the document is modified. Note a handle can only have one subscriber - if you need more, you need to open another handle. 

```js
repo.watch(url, (doc) => {
  console.log(doc)
})
```

### `repo.doc(id, callback)` 

Gives you read-only access to the document's state at a single point in time. 

```js  
repo.doc(id, (doc) => {
  console.log(doc) 
})
```

### `repo.change(id, callback)` 

Gives you access to an mutable version of the document. 

```js
repo.change(url, (doc) => {
  doc.foo = 'bar'
})
```

Within the callback, you can treat the document as a plain old JavaScript object. Automerge takes care of detecting changes and generating a read-only log for storage and replication. [See the Automerge docs](https://github.com/automerge/automerge#manipulating-and-inspecting-state) for details on how this works. 

-------

### API documentation checklist

#### Repo

- [ ] repo.back
- [x] repo.change
- [ ] repo.close
- [x] repo.create
- [ ] repo.destroy
- [x] repo.doc
- [ ] repo.fork
- [ ] repo.front
- [ ] repo.id
- [ ] repo.materialize
- [ ] repo.merge
- [ ] repo.meta
- [ ] repo.open
- [ ] repo.readFile
- [ ] repo.replicate
- [ ] repo.stream
- [x] repo.watch
- [ ] repo.writeFile




[automerge]: https://github.com/automerge/automerge
[hypercore]: https://github.com/mafintosh/hypercore
