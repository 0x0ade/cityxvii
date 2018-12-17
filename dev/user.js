/* globals DatArchive */

import {newId} from './new-id.js'
import {toUrl, toDomain, ensureFolderExists} from './util.js'
import * as Schemas from './schemas.js'
import {NotTheOwnerError} from './errors.js'

// exported api
// =

export class User extends DatArchive {
  constructor (url) {
    url = toUrl(url)
    super(url)
    this.getDomainName = () => (new URL(url)).hostname

    this.microblog = new MicroblogAPI(this)
  }

  async setup () {
    var info = await this.getInfo()
    if (!info.isOwner) {
      throw new NotTheOwnerError()
    }
    await Promise.all([
      this.microblog.setup()
    ])
  }

  getProfile () {
    return new Schemas.Profile(profile, this.url)
  }

  async setProfile (details) {
    // lock
    // TODO

    // read current
    var profile = await this.getProfile()

    // update
    for (var k in details) {
      profile[k] = details[k]
    }

    // write file
    await this.writeFile('/profile.json', JSON.stringify(profile))
  }

  async setAvatar ({data, format}) {
    // TODO
    throw new Error('setAvatar() Not yet implemented')
  }

  async follow (url, {name} = {}) {
    url = toDomain(url)

    // lock
    // TODO

    // read, update, write
    var profile = await this.getProfile()
    profile.follows = profile.follows.filter(f => f.url !== url)
    profile.follows.push({url, name})
    await this.setProfile(profile)
  }

  async unfollow (url) {
    url = toDomain(url)

    // lock
    // TODO

    // read, update, write
    var profile = await this.getProfile()
    profile.follows = profile.follows.filter(f => toDomain(f.url) !== url)
    await this.setProfile(profile)
  }

  async isFollowing (url) {
    var profile = await this.getProfile()
    return profile.follows.find(f => toDomain(f.url) === url)
  }

  async listFollows () {
    var profile = await this.getProfile()
    return profile.follows
  }
}

// internal methods
// =

function _fixFilename (filename) {
  if (!filename.endsWith('.json'))
    filename += '.json'
  return filename
}

class UserAPI {
  constructor (user) {
    this.user = user
  }

  async setup () {
    // should be overridden as needed
  }
}

class MicroblogAPI extends UserAPI {
  async setup () {
    await ensureFolderExists(this.user, '/posts')
  }

  generatePostFilename () {
    return newId() + '.json'
  }

  getPostUrl (filename) {
    return this.user.url + '/posts/' + filename
  }

  async list (query) {
    query = new Schemas.MicroblogPostsQuery(query)

    // read contents of /posts
    var names = await this.user.readdir('/posts')

    // apply pre-filter operations
    if (query.reverse) {
      names.reverse()
    }
    if (query.offset) {
      names = names.slice(query.offset)
    }

    // fetch post content if requested
    var posts
    if (query.includeContent) {
      posts = await Promise.all(names.map(this.get.bind(this)))
    } else {
      posts = names.map(name => new Schemas.MicroblogPost(null, this.getPostUrl(name)))
    }

    // content-based filters
    if (query.rootPostsOnly) {
      posts = posts.filter(post => !post.threadParent && !post.threadRoot)
    }

    // apply post-filter operations
    if (query.limit) {
      posts = posts.slice(0, query.limit)
    }

    return posts
  }

  async count (query) {
    return (await this.list(query)).length
  }

  async get (filename) {
    // read file
    filename = _fixFilename(filename)

    // var post = await this.user.readFile('/posts/' + filename)
    // return new Schemas.MicroblogPost(post, this.getPostUrl(filename))

    // fetch makes use of the browser's cache
    var url = this.getPostUrl(filename)
    var r = await fetch(url)
    if (!r.ok) {
      let e = new Error(r.statusText)
      e.notFound = r.status === 404
      throw e
    }
    return new Schemas.MicroblogPost(await r.json(), url)
  }

  async add (details) {
    massagePostDetails(details)
    details.createdAt = details.createdAt || Date.now()

    // write to new file
    var filename = await this.generatePostFilename()
    var post = new Schemas.MicroblogPost(details, this.getPostUrl(filename))
    await this.user.writeFile('/posts/' + filename, JSON.stringify(post))
    return post
  }

  async edit (filename, details) {
    filename = _fixFilename(filename)
    massagePostDetails(details)

    // lock region
    // TODO

    // read file
    var post = await this.get(filename)

    // update data
    for (var k in details) {
      post[k] = details[k]
    }

    // write file
    await this.user.writeFile('/posts/' + filename, JSON.stringify(post))
    return post
  }

  async remove (filename) {
    // delete file
    filename = _fixFilename(filename)
    await this.user.unlink('/posts/' + filename)
  }
}

function massagePostDetails (details) {
  if (details.threadRoot && !details.threadParent) {
    details.threadParent = details.threadRoot
  }
  if (!details.threadRoot && details.threadParent) {
    details.threadRoot = details.threadParent
  }
  if (details.threadRoot) details.threadRoot = toUrl(details.threadRoot)
  if (details.threadParent) details.threadParent = toUrl(details.threadParent)
}
