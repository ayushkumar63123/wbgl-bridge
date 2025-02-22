import {confirmations, feePercentage, bsc} from '../utils/config.js'
import {Data, RPC, Eth, Bsc} from './index.js'
import Transaction from '../models/Transaction.js'
import Transfer from '../models/Transfer.js'
import Conversion from '../models/Conversion.js'

const expireDate = () => {
  const expireDate = new Date()
  expireDate.setTime(expireDate.getTime() - (7 * 24 * 3600000))
  return expireDate.toISOString()
}

const deductFee = amount => parseFloat(((100 - feePercentage) * amount / 100).toFixed(3))

async function returnBGL(conversion, address) {
  try {
    conversion.status = 'returned'
    await conversion.save()
    conversion.returnTxid = await RPC.send(address, conversion.amount)
    await conversion.save()
  } catch (e) {
    console.error(`Error returning BGL to ${address}, conversion ID: ${conversion._id}.`, e)
    conversion.status = 'error'
    await conversion.save()
  }
}

async function returnWBGL(Chain, conversion, address) {
  try {
    conversion.status = 'returned'
    await conversion.save()
    conversion.returnTxid = await Chain.sendWBGL(address, conversion.amount.toString())
    await conversion.save()
  } catch (e) {
    console.error(`Error returning WBGL (${Chain.id}) to ${address}, conversion ID: ${conversion._id}.`, e)
    conversion.status = 'error'
    await conversion.save()
  }
}

async function checkBglTransactions() {
  const blockHash = await Data.get('lastBglBlockHash')
  const result = await RPC.listSinceBlock(blockHash || undefined, confirmations.bgl)

  result.transactions.filter(tx => tx.confirmations >= confirmations.bgl && tx.category === 'receive').forEach(tx => {
    Transfer.findOne({type: 'bgl', from: tx.address, updatedAt: {$gte: expireDate()}}).exec().then(async transfer => {
      if (transfer && ! await Transaction.findOne({id: tx['txid']}).exec()) {
        const Chain = transfer.chain === 'bsc' ? Bsc : Eth
        const fromAddress = await RPC.getTransactionFromAddress(tx['txid'])
        const transaction = await Transaction.create({
          type: 'bgl',
          id: tx['txid'],
          transfer: transfer._id,
          address: fromAddress,
          amount: tx['amount'],
          blockHash: tx['blockhash'],
          time: new Date(tx['time'] * 1000),
        })
        const amount = deductFee(tx['amount'])
        const conversion = await Conversion.create({
          type: 'wbgl',
          chain: transfer.chain,
          transfer: transfer._id,
          transaction: transaction._id,
          address: transfer.to,
          amount: tx['amount'],
          sendAmount: amount,
        })

        if (amount > await Chain.getWBGLBalance()) {
          console.log(`Insufficient WBGL balance, returning ${tx['amount']} BGL to ${fromAddress}`)
          await returnBGL(conversion, fromAddress)
          return
        }

        try {
          conversion.txid = await Chain.sendWBGL(transfer.to, amount.toString())
          await conversion.save()
        } catch (e) {
          console.log(`Error sending ${amount} WBGL to ${transfer.to}`, e)
          conversion.status = 'error'
          await conversion.save()

          await returnBGL(conversion, fromAddress)
        }
      }
    })
  })

  await Data.set('lastBglBlockHash', result['lastblock'])

  setTimeout(checkBglTransactions, 60000)
}

async function subscribeToTokenTransfers(Chain = Eth, prefix = 'Eth') {
  const blockNumber = await Data.get(`last${prefix}BlockNumber`, async () => await Chain.web3.eth.getBlockNumber() - 1000)
  Chain.WBGL.events.Transfer({
    fromBlock: blockNumber + 1,
    filter: {to: Chain.custodialAccountAddress},
  }).on('data', async event => {
    const fromQuery = {$regex: new RegExp(`^${event.returnValues.from}$`, 'i')}
    Transfer.findOne({type: 'wbgl', chain: Chain.id, from: fromQuery, updatedAt: {$gte: expireDate()}}).exec().then(async transfer => {
      if (transfer && ! await Transaction.findOne({chain: Chain.id, id: event.transactionHash}).exec()) {
        const amount = Chain.convertWGBLBalance(event.returnValues.value)
        const sendAmount = deductFee(amount)
        const transaction = await Transaction.create({
          type: 'wbgl',
          chain: Chain.id,
          id: event.transactionHash,
          transfer: transfer._id,
          address: event.returnValues.from,
          amount,
          blockHash: event.blockHash,
          time: Date.now(),
        })
        const conversion = await Conversion.create({
          type: 'bgl',
          chain: Chain.id,
          transfer: transfer._id,
          transaction: transaction._id,
          address: transfer.to,
          amount,
          sendAmount,
        })

        if (amount > await RPC.getBalance()) {
          console.log(`Insufficient BGL balance, returning ${amount} WBGL to ${transfer.from}`)
          await returnWBGL(Chain, conversion, transfer.from)
          return
        }

        try {
          conversion.txid = await RPC.send(transfer.to, sendAmount)
          conversion.status = 'sent'
          await conversion.save()
        } catch (e) {
          console.error(`Error sending ${sendAmount} BGL to ${transfer.to}`, e)
          conversion.status = 'error'
          await conversion.save()

          await returnWBGL(Chain, conversion, transfer.from)
        }
      }
    })
    await Data.set(`last${prefix}BlockHash`, event.blockHash)
    await Data.set(`last${prefix}BlockNumber`, event.blockNumber)
  })
}

async function checkPendingConversions(Chain) {
  const conversions = await Conversion.find({chain: Chain.id, type: 'wbgl', status: 'pending', txid: {$exists: true}}).exec()
  let blockNumber
  for (const conversion of conversions) {
    const receipt = await Chain.getTransactionReceipt(conversion.txid)
    if (receipt && (blockNumber || await Chain.web3.eth.getBlockNumber()) - receipt.blockNumber >= Chain.confirmations) {
      conversion.status = 'sent'
      conversion.receipt = receipt
      conversion.markModified('receipt')
      await conversion.save()
    }
  }
  setTimeout(() => checkPendingConversions(Chain), 60000)
}

export const init = async () => {
  await subscribeToTokenTransfers(Eth, 'Eth')
  await subscribeToTokenTransfers(Bsc, 'Bsc')

  await checkBglTransactions()

  await checkPendingConversions(Eth)
  await checkPendingConversions(Bsc)
}
