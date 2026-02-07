import { ethers } from 'ethers'

const proposals = new Map()
let proposalCounter = 0

function getProvider() {
  const rpcUrl = process.env.AXIOM_RPC_URL || 'https://eth.llamarpc.com'
  return new ethers.JsonRpcProvider(rpcUrl)
}

function getWallet() {
  const key = process.env.AXIOM_WALLET_KEY
  if (!key) return null
  return new ethers.Wallet(key, getProvider())
}

export default {
  actuatorId: 'crypto-wallet',

  tools: [
    {
      name: 'check_wallet_balance',
      description: 'Check the AXIOM wallet address, ETH balance, and network info',
      input_schema: {
        type: 'object',
        properties: {},
        required: []
      }
    },
    {
      name: 'propose_transaction',
      description: 'Propose an ETH transaction (does NOT send). Returns a proposal ID for review.',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Destination Ethereum address' },
          value: { type: 'string', description: 'Amount in ETH (e.g. "0.01")' },
          reason: { type: 'string', description: 'Why this transaction is needed' }
        },
        required: ['to', 'value', 'reason']
      }
    },
    {
      name: 'execute_transaction',
      description: 'Execute a previously proposed transaction. Requires proposal ID and explicit confirmation.',
      input_schema: {
        type: 'object',
        properties: {
          proposalId: { type: 'string', description: 'The proposal ID from propose_transaction' },
          confirm: { type: 'boolean', description: 'Must be true to execute' }
        },
        required: ['proposalId', 'confirm']
      }
    }
  ],

  execute: async (toolName, input) => {
    if (toolName === 'check_wallet_balance') {
      const wallet = getWallet()
      if (!wallet) {
        return JSON.stringify({
          configured: false,
          message: 'Wallet not configured. Set AXIOM_WALLET_KEY and optionally AXIOM_RPC_URL in server .env.'
        })
      }

      try {
        const provider = getProvider()
        const [balance, network] = await Promise.all([
          provider.getBalance(wallet.address),
          provider.getNetwork()
        ])

        console.log(`[crypto-wallet] Balance check: ${wallet.address} = ${ethers.formatEther(balance)} ETH`)

        return JSON.stringify({
          configured: true,
          address: wallet.address,
          balance: ethers.formatEther(balance),
          unit: 'ETH',
          network: { name: network.name, chainId: Number(network.chainId) },
          rpcUrl: process.env.AXIOM_RPC_URL || 'https://eth.llamarpc.com (public)'
        })
      } catch (err) {
        console.log(`[crypto-wallet] Balance check error: ${err.message}`)
        return JSON.stringify({ configured: true, error: err.message })
      }
    }

    if (toolName === 'propose_transaction') {
      const wallet = getWallet()
      if (!wallet) {
        return 'Error: Wallet not configured. Set AXIOM_WALLET_KEY in server .env.'
      }

      if (!ethers.isAddress(input.to)) {
        return `Error: Invalid Ethereum address "${input.to}"`
      }

      let valueWei
      try {
        valueWei = ethers.parseEther(input.value)
      } catch {
        return `Error: Invalid ETH amount "${input.value}"`
      }

      try {
        const provider = getProvider()
        const [balance, feeData] = await Promise.all([
          provider.getBalance(wallet.address),
          provider.getFeeData()
        ])

        const estimatedGas = 21000n
        const maxFee = feeData.maxFeePerGas || feeData.gasPrice
        const estimatedCost = valueWei + (estimatedGas * maxFee)

        if (balance < estimatedCost) {
          return JSON.stringify({
            error: 'Insufficient balance',
            balance: ethers.formatEther(balance),
            estimatedCost: ethers.formatEther(estimatedCost),
            value: input.value
          })
        }

        const id = `txp-${++proposalCounter}`
        proposals.set(id, {
          to: input.to,
          value: input.value,
          valueWei: valueWei.toString(),
          reason: input.reason,
          estimatedGas: estimatedGas.toString(),
          maxFeePerGas: maxFee.toString(),
          createdAt: new Date().toISOString()
        })

        console.log(`[crypto-wallet] Proposal ${id}: ${input.value} ETH → ${input.to} (${input.reason})`)

        return JSON.stringify({
          proposalId: id,
          from: wallet.address,
          to: input.to,
          value: input.value,
          estimatedGasCost: ethers.formatEther(estimatedGas * maxFee),
          reason: input.reason,
          status: 'pending — call execute_transaction with confirm: true to send'
        })
      } catch (err) {
        console.log(`[crypto-wallet] Proposal error: ${err.message}`)
        return `Error creating proposal: ${err.message}`
      }
    }

    if (toolName === 'execute_transaction') {
      if (!input.confirm) {
        return 'Error: confirm must be true to execute a transaction'
      }

      const proposal = proposals.get(input.proposalId)
      if (!proposal) {
        return `Error: Proposal "${input.proposalId}" not found. Proposals are cleared on server restart.`
      }

      const wallet = getWallet()
      if (!wallet) {
        return 'Error: Wallet not configured'
      }

      try {
        console.log(`[crypto-wallet] Executing ${input.proposalId}: ${proposal.value} ETH → ${proposal.to}`)

        const tx = await wallet.sendTransaction({
          to: proposal.to,
          value: BigInt(proposal.valueWei)
        })

        const receipt = await tx.wait()
        proposals.delete(input.proposalId)

        console.log(`[crypto-wallet] TX confirmed: ${tx.hash} (block ${receipt.blockNumber})`)

        return JSON.stringify({
          success: true,
          hash: tx.hash,
          blockNumber: receipt.blockNumber,
          from: tx.from,
          to: tx.to,
          value: proposal.value,
          gasUsed: receipt.gasUsed.toString(),
          explorer: `https://etherscan.io/tx/${tx.hash}`
        })
      } catch (err) {
        console.log(`[crypto-wallet] TX error: ${err.message}`)
        return `Error executing transaction: ${err.message}`
      }
    }

    return `Unknown tool: ${toolName}`
  },

  verify: async () => {
    const wallet = getWallet()
    if (!wallet) {
      return {
        operational: false,
        evidence: 'AXIOM_WALLET_KEY not set in environment'
      }
    }

    try {
      const provider = getProvider()
      const balance = await provider.getBalance(wallet.address)
      return {
        operational: true,
        evidence: `Wallet ${wallet.address} connected, balance: ${ethers.formatEther(balance)} ETH`
      }
    } catch (err) {
      return {
        operational: false,
        evidence: `Wallet key set but RPC error: ${err.message}`
      }
    }
  }
}
