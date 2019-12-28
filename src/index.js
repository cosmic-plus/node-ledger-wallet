"use strict"
/**
 * This library is a convenient wrapper around the official Ledger libraries for
 * Stellar:
 *
 * - [Stellar app API](https://www.npmjs.com/package/@ledgerhq/hw-app-str)
 * - [Transport Node HID](https://www.npmjs.com/package/@ledgerhq/hw-transport-node-hid) - Node.js support
 * - [Transport U2F](https://www.npmjs.com/package/@ledgerhq/hw-transport-u2f) - Browser support
 *
 * It provides a way to support Ledger Wallets with a few one-liners:
 *
 * ```js
 * // Step 1: Connect
 * await ledgerWallet.connect()
 *
 * // Step 2: Get public key
 * const pubkey = ledgerWallet.publicKey
 *
 * // Step 3: Sign transaction
 * await ledgerWallet.sign(transaction)
 *
 * // Extra: Event handlers
 * ledgerWallet.onConnect = connectionHandler
 * ledgerWallet.onDisconnect = disconnectionHandler
 * ```
 *
 * This library is compatible with both Node.js and browser environments.
 *
 * @exports ledgerWallet
 */
const ledger = exports

const env = require("@cosmic-plus/jsutils/es5/env")

if (env.isNode) {
  global.regeneratorRuntime = env.nodeRequire("regenerator-runtime")
}

const StellarApp = require("@ledgerhq/hw-app-str").default
const Transport = env.isBrowser
  ? require("@ledgerhq/hw-transport-u2f").default
  : env.nodeRequire("@ledgerhq/hw-transport-node-hid").default

/* Configuration */
const BIP_PATH = "44'/148'"

/* Properties */

/**
 * Public key of the connected account.
 * @var {String}
 */
ledger.publicKey = null

/**
 * Derivation path of the connected account (default: `m/44'/148'/0'`).
 * @var {String}
 */
ledger.path = null

/**
 * Version of the Stellar application installed on the connected device.
 * @var {String}
 */
ledger.version = null

/**
 * Whether or not the user accepts to sign transactions without checking them on
 * the device first. This allows to sign long transactions (10+ ops) that could
 * normally not be handled by the device memory, but this is insecure.
 * @var {Boolean}
 */
ledger.multiOpsEnabled = null

/**
 * The Ledger Transport instance. (internal component)
 * @var {Transport}
 */
ledger.transport = null

/**
 * The Ledger Stellar application instance. (internal component)
 * @var {StellarApp}
 */
ledger.application = null

/* Methods */

let connection, disconnection

/**
 * Waits for a connection with the Ledger Wallet application for Stellar. If
 * **account** is not provided, account 1 is used. The library will stop
 * listening for a connection if `await ledgerWallet.disconnect()` is called.
 *
 * Once the connection is established, you can use `await
 * ledgerWallet.connect(account)` again at any time to ensure the device is
 * still connected.
 *
 * When switching to another account, you can `await
 * ledgerWallet.connect(new_account)` without prior disconnection.
 *
 * _Note:_ To stay consistent with the way Trezor numbers accounts, **account**
 * starts at 1 (derivation path: `m/44'/148'/0'`).
 *
 * @async
 * @param [account=1] {Number|String} - Either an account number (starts at 1)
 * or a derivation path (e.g: `m/44'/148'/0'`).
 */
ledger.connect = async function (account = 1) {
  const path = ledger.connect.path(account)
  if (disconnection) await disconnection
  if (ledger.path && ledger.path !== path) softReset()
  if (!connection) connection = connect(path)
  return connection
}

ledger.connect.path = function (account) {
  if (typeof account === "number") {
    if (account < 1) throw new Error("Account number starts at 1.")
    return `${BIP_PATH}/${account - 1}'`
  } else {
    return account.replace(/^m\//, "")
  }
}

async function connect (path) {
  // eslint-disable-next-line no-console
  console.log("Attempting ledger connection...")
  connection = true

  // Try to connect until disconnect() is called or until connection happens.
  let startTime
  while (connection && !ledger.publicKey) {
    startTime = +new Date()

    try {
      if (!ledger.transport || env.isNode) {
        ledger.transport = await Transport.create()
      }
      if (!ledger.application || env.isNode) {
        ledger.application = new StellarApp(ledger.transport)
      }
      // Set ledger.publicKey
      Object.assign(ledger, await ledger.application.getPublicKey(path))
      Object.assign(ledger, await ledger.application.getAppConfiguration())
      ledger.path = path
      onConnect()
    } catch (error) {
      if (error.id === "U2FNotSupported") {
        // This frame may show up when using strict Content-Security-Policy
        // See: https://github.com/LedgerHQ/ledgerjs/issues/254
        const iframeSelector = "iframe[src^=chrome-extension/*/u2f-comms.html]"
        const iframe = document.querySelector(iframeSelector)
        if (iframe) iframe.parentNode.removeChild(iframe)
      }

      // If error happened within 25 seconds, we throw. Else, we assume a
      // timeout.
      const errorTime = +new Date()
      if (errorTime - startTime < 25000) {
        softReset()
        throw error
      }
    }
  }
}

/**
 * Prompts the user to accept **transaction** using the connected account of
 * their Ledger Wallet.
 *
 * If the user accepts, adds the signature to **transaction**. Else, throws an
 * error.
 *
 * @async
 * @param transaction {Transaction} A StellarSdk Transaction
 */
ledger.sign = async function (transaction) {
  if (!ledger.publicKey) throw new Error("No ledger wallet connected.")

  const result = await ledger.application.signTransaction(
    ledger.path,
    transaction.signatureBase()
  )
  const signature = result.signature.toString("base64")
  transaction.addSignature(ledger.publicKey, signature)

  return transaction
}

/**
 * Close the connection with the Ledger device, or stop waiting for one in case
 * a connection has not been established yet.
 *
 * @async
 */
ledger.disconnect = async function () {
  const transport = ledger.transport
  reset()

  if (transport) {
    disconnection = closeTransport(transport)
    disconnection.then(onDisconnect)
    await disconnection
  } else if (disconnection) {
    await disconnection
  }
  disconnection = null
}

async function closeTransport (transport) {
  // If transport is not valid anymore we consider the transport as closed.
  try {
    await transport.close()
  } catch (error) {
    console.error(error)
  }
}

function softReset () {
  connection = null
  ledger.path = null
  ledger.publicKey = null
}

function reset () {
  connection = null
  libValues.forEach(key => ledger[key] = null)
}

const libValues = [
  "transport",
  "application",
  "path",
  "version",
  "publicKey",
  "multiOpsEnabled"
]

/* Events */

/**
 * _Function_ to execute on each connection.
 *
 * @category event
 * @var {Function}
 */
ledger.onConnect = null
async function onConnect () {
  // eslint-disable-next-line no-console
  console.log("Ledger connected")
  if (typeof ledger.onConnect === "function") ledger.onConnect()
}

/**
 * _Function_ to execute on each disconnection.
 *
 * @category event
 * @var {Function}
 */
ledger.onDisconnect = null
function onDisconnect () {
  // eslint-disable-next-line no-console
  console.log("Ledger disconnected")
  if (typeof ledger.onDisconnect === "function") ledger.onDisconnect()
}
