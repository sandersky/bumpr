require('./typedefs')

const chalk = require('chalk')
const {cloneDeep, get} = require('lodash')
const moment = require('moment-timezone')
const fetch = require('node-fetch')
const Promise = require('promise')
const replace = require('replace-in-file')
const versiony = require('versiony')

const {name} = require('../package.json')
const {exec, writeFile} = require('./node-wrappers')

const {Logger} = require('./logger')
const utils = require('./utils')

/**
 * Perform the patch bump, either using .patch() or .preRelease() (the latter if there's a pre-release tag)
 * @param {*} v - the versiony instance
 */
function performPatch(v) {
  if (v.model.hasPreRelease()) {
    v.preRelease()
  } else {
    v.patch()
  }
}

function postBody(url, body) {
  return fetch(url, {
    headers: {'Content-Type': 'application/json'},
    method: 'POST',
    body: JSON.stringify(body)
  })
}

class MissingKeyError extends Error {
  constructor(key, logFile) {
    super(`no ${chalk.yellowBright(key)} key found in ${chalk.magentaBright(logFile)}`)
  }
}

class NoLogFileError extends Error {
  constructor(logFile) {
    super(`log file ${chalk.magentaBright(logFile)} not found.`)
  }
}

/**
 * Interacts with a Vcs to achieive a version bump
 * @class
 */
class Bumpr {
  // = Public Methods ===================================================================

  /**
   * @param {Object} params - params obj
   * @param {Config} params.config - the bumper config object
   * @param {Vcs} params.vcs - the vcs instance to use
   * @param {Ci} params.ci - the ci instance to use
   */
  constructor({ci, config, vcs}) {
    this.ci = ci
    this.config = config
    this.vcs = vcs
  }

  /**
   * Bump the version based on the last merged PR's version-bump comment
   * @param {Object} options the cli options
   * @returns {Promise} a promise resolved with the results of the push
   */
  bump() {
    if (get(this.config, 'computed.ci.isPr')) {
      Logger.log('Not a merge build, skipping bump')
      return Promise.resolve()
    }

    return this.getMergedPrInfo()
      .then(info => this.maybeBumpVersion(info))
      .then(info => this.maybeUpdateChangelog(info))
      .then(info => this.maybeCommitChanges(info))
      .then(info => this.maybeCreateTag(info))
      .then(info => this.maybePushChanges(info))
      .then(info => this.maybeLogChanges(info))
  }

  /**
   * Check a PR for a version-bump comment
   * @returns {Promise} a promise resolved when complete or rejected on error
   */
  check() {
    if (!this.config.computed.ci.isPr) {
      Logger.log('Not a PR build, skipping check')
      return Promise.resolve()
    }

    return this.getOpenPrInfo().then(info => {
      Logger.log(`Found a ${info.scope} bump for the current PR`)
    })
  }

  /**
   * Read the bumpr log and output the given key from it
   * @returns {Promise} a promise resolved with the value or rejected on error
   */
  log(key) {
    return this.getLog()
      .then(({file, log}) => ({file, value: get(log, key)}))
      .then(({file, value}) => {
        if (value === undefined) {
          throw new MissingKeyError(key, file)
        }

        return value
      })
  }

  /**
   * Publish the package if a non-none bump has occurred
   * @returns {Promise} a promise resolved when publish completes (or is skipped) or rejected on error
   */
  publish() {
    return this.getLog()
      .then(({log}) => {
        if (!log.scope) {
          Logger.log('Skipping publish because no scope found.', true)
          return Promise.resolve()
        }

        if (log.scope === 'none') {
          Logger.log('Skipping publish because of "none" scope.', true)
          return Promise.resolve()
        }

        // eslint-disable-next-line no-template-curly-in-string
        return writeFile('.npmrc', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}')
          .then(() => exec('npm publish .'))
          .then(() => this.maybeSendSlackMessage(log))
      })
      .catch(err => {
        if (err instanceof NoLogFileError) {
          Logger.log('Skipping publish because no log file found.', true)
        } else {
          throw err
        }
      })
  }

  /**
   * Get the contents of the given log file
   * @param {String} filename - the name of the log file
   * @returns {Promise} a promise resolved with the log contents and filename or rejected with an error
   */
  getLog() {
    const logFile = get(this.config, 'features.logging.file')
    try {
      Logger.log(`Reading log file from ${logFile}`)
      return Promise.resolve({
        file: logFile,
        log: utils.readJsonFile(logFile)
      })
    } catch (err) {
      const rejection = err.code === 'ENOENT' ? new NoLogFileError(logFile) : err
      Logger.log(`Error reading log file: ${rejection.message}`)
      return Promise.reject(rejection)
    }
  }

  /**
   * Grab the most recent PR
   * @returns {PrPromise} a promise resolved with the most recent PR
   */
  getLastPr() {
    return exec('git rev-list HEAD --max-count=1').then(stdout => {
      const sha = stdout.trim()
      Logger.log(`Fetching PR for sha [${sha}]`)
      return this.vcs.getMergedPrBySha(sha)
    })
  }

  /**
   * Get the PR scope for the current (merged) pull request
   * @returns {Promise} a promise - resolved with PR info (changelog and scope) or rejected on error
   */
  getMergedPrInfo() {
    return this.getLastPr().then(pr => {
      let maxScope = 'major'
      if (this.config.isEnabled('maxScope')) {
        maxScope = this.config.features.maxScope.value
      }
      const scope = utils.getScopeForPr(pr, maxScope)
      const getChangelog = this.config.isEnabled('changelog') && scope !== 'none'

      return {
        author: pr.author,
        authorUrl: pr.authorUrl,
        changelog: getChangelog ? utils.getChangelogForPr(pr) : '',
        modifiedFiles: [],
        number: pr.number,
        scope,
        url: pr.url
      }
    })
  }

  /**
   * Get the pr scope for the current (open) pull request
   * @returns {Promise} a promise - resolved with PR info (changelog and scope) or rejected on error
   */
  getOpenPrInfo() {
    return this.vcs
      .getPr(this.config.computed.ci.prNumber)
      .then(pr => {
        let scope
        return utils.maybePostCommentOnError(this.config, this.vcs, () => {
          let maxScope = 'major'
          if (this.config.isEnabled('maxScope')) {
            maxScope = this.config.features.maxScope.value
          }
          scope = utils.getScopeForPr(pr, maxScope)
          return {pr, scope}
        })
      })
      .then(data => {
        const {pr, scope} = data

        const getChangelog = this.config.isEnabled('changelog') && scope !== 'none'
        let changelog = ''
        if (getChangelog) {
          return utils.maybePostCommentOnError(this.config, this.vcs, () => {
            changelog = utils.getChangelogForPr(pr)
            return {changelog, number: pr.number, scope, url: pr.url}
          })
        }

        return Promise.resolve({changelog, number: pr.number, scope, url: pr.url})
      })
  }

  /**
   * Maybe bump the version in files with the given scope (if it's not "none")
   * NOTE: it is assumed that all files include the same version and so applying the same scope will
   * result in the same new version for all files
   * @param {PrInfo} info - the pr info
   * @returns {PrInfo} the updated pr info object
   */
  maybeBumpVersion(info) {
    const newInfo = cloneDeep(info)
    if (newInfo.scope === 'none') {
      return newInfo
    }

    const {files} = this.config

    files.forEach(filename => {
      const v = versiony.from(filename)
      switch (newInfo.scope) {
        case 'patch':
          performPatch(v)
          break

        case 'minor':
          v.newMinor()
          break

        case 'major':
          v.newMajor()
          break

        default:
          throw new Error(`Invalid scope [${newInfo.scope}]`)
      }

      const versionInfo = v.to(filename).end({quiet: true})
      newInfo.version = versionInfo.version // eslint-disable-line no-param-reassign
      newInfo.modifiedFiles.push(filename)
    })

    return newInfo
  }

  /**
   * Commit the changed files that were modified by pr-bumper
   * @param {PrInfo} info - the info for the PR being bumped
   * @returns {Promise} - a promise resolved with the results of the git commands
   */
  maybeCommitChanges(info) {
    if (info.modifiedFiles.length === 0) {
      Logger.log('Skipping commit because no files were changed.')
      return Promise.resolve(info)
    }

    const {buildNumber} = this.config.computed.ci

    return this.ci
      .setupGitEnv()
      .then(() => this.ci.add(info.modifiedFiles))
      .then(() => {
        const msg = `Version bump to ${info.version}`

        return this.ci.commit(`[ci skip] [${name}] ${msg}`, `From CI build ${buildNumber}`).then(() => info)
      })
  }

  /**
   * Maybe create a tag based on the current version
   * @param {PrInfo} info - the info for the PR being bumped
   * @returns {Promise} - a promise resolved with the results of the git commands
   */
  maybeCreateTag(info) {
    if (info.scope === 'none') {
      Logger.log('Skipping tag creation because of "none" scope.')
      return Promise.resolve(info)
    }

    const {buildNumber} = this.config.computed.ci
    return this.ci.tag(`v${info.version}`, `Generated tag from CI build ${buildNumber}`).then(() => info)
  }

  /**
   * Maybe log changes to a file
   * @param {PrInfo} info - the info for the PR being bumped
   * @returns {Promise} - a promise resolved with the results of the git commands
   */
  maybeLogChanges(info) {
    if (!this.config.isEnabled('logging')) {
      Logger.log('Skipping logging because of config option.')
      return Promise.resolve(info)
    }
    const {author, authorUrl, changelog, number, scope, url, version} = info

    const logInfo = {
      changelog,
      pr: {
        number,
        url,
        user: {
          login: author,
          url: authorUrl
        }
      },
      scope,
      version
    }

    const filename = this.config.features.logging.file
    Logger.log(`Writing ${JSON.stringify(logInfo)} to ${filename}`)
    return writeFile(filename, JSON.stringify(logInfo, null, 2)).then(() => info)
  }

  /**
   * Maybe update the changelog file with the changelog text from the PrInfo
   * @param {PrInfo} info - the pr info
   * @returns {Promise} - a promise resolved when changelog has been updated
   */
  maybeUpdateChangelog(info) {
    if (!this.config.isEnabled('changelog')) {
      Logger.log('Skipping update changelog because of config option.')
      return Promise.resolve(info)
    }

    if (info.scope === 'none') {
      Logger.log('Skipping update changelog because of "none" scope.')
      return Promise.resolve(info)
    }

    let timezone = 'Etc/UTC'
    if (this.config.isEnabled('timezone')) {
      timezone = this.config.features.timezone.zone
    }

    const dateString = moment()
      .tz(timezone)
      .format('YYYY-MM-DD')

    const prLink = `[PR ${info.number}](${info.url})`
    const data = `<!-- bumpr -->\n\n## [${info.version}] - ${dateString} (${prLink})\n${info.changelog}`
    const filename = this.config.features.changelog.file
    const options = {
      files: filename,
      from: /<!-- bumpr -->/,
      to: data
    }

    return replace(options).then(() => {
      info.modifiedFiles.push(filename)
      return info
    })
  }

  /**
   * Maybe push changes back to repo
   * @param {PrInfo} info - the info for the PR being bumped
   * @returns {Promise} - a promise resolved with the results of the git commands
   */
  maybePushChanges(info) {
    if (info.modifiedFiles.length === 0) {
      Logger.log('Skipping push because nothing changed.')
      return Promise.resolve(info)
    }

    return this.ci.push(this.vcs).then(() => info)
  }

  /**
   * Maybe send a slack message with the log info
   * @param {Object} log - the already read log
   * @returns {Promise} the promise that resolves when slack messages have sent or rejects on error
   */
  maybeSendSlackMessage({pr, scope, version}) {
    if (!this.config.isEnabled('slack')) {
      Logger.log('Skipping sending slack message because of config option.')
      return Promise.resolve()
    }
    const {number, url, user} = pr
    const {slackUrl} = this.config.computed
    const pkg = utils.readJsonFile('package.json')
    const pkgStr = `${pkg.name}@${version}`
    const message = `Published \`${pkgStr}\` (${scope}) from <${url}|PR #${number}> by <${user.url}|${user.login}>`

    const {channels} = this.config.features.slack
    if (channels.length === 0) {
      return postBody(slackUrl, {text: message})
    }

    return Promise.all(channels.map(channel => postBody(slackUrl, {channel, text: message})))
  }
}

Bumpr.MissingKeyError = MissingKeyError
Bumpr.NoLogFileError = NoLogFileError

module.exports = Bumpr
