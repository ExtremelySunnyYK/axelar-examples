'use strict';

const {
    getDefaultProvider,
    Contract,
    constants: { AddressZero },
    ethers,
} = require('ethers');
const {
    utils: { deployContract },
} = require('@axelar-network/axelar-local-dev');
// const { deployUpgradable } = require('@axelar-network/axelar-gmp-sdk-solidity');
const DistributionExecutable = rootRequire(
    './artifacts/examples/evm/call-contract-with-token-express/DistributionExpressExecutable.sol/DistributionExpressExecutable.json',
);
const ExpressProxy = require('@axelar-network/axelar-gmp-sdk-solidity/artifacts/contracts/express/ExpressProxy.sol/ExpressProxy.json');
// const ExpressProxy = require('@axelar-network/axelar-gmp-sdk-solidity/artifacts/contracts/express/');
const Gateway = rootRequire(
    './artifacts/@axelar-network/axelar-gmp-sdk-solidity/contracts/interfaces/IAxelarGateway.sol/IAxelarGateway.json',
);
const IERC20 = rootRequire('./artifacts/@axelar-network/axelar-gmp-sdk-solidity/contracts/interfaces/IERC20.sol/IERC20.json');

async function deploy(chain, wallet) {
    console.log(`Deploying DistributionExecutable for ${chain.name}.`);
    const provider = getDefaultProvider(chain.rpc);
    chain.wallet = wallet.connect(provider);
    chain.contract = await deployContract(chain.wallet, DistributionExecutable, [chain.gateway, chain.gasService]);
    console.log(`Deployed DistributionExecutable for ${chain.name} at ${chain.contract.address}.`);
    chain.expressService = new Contract(
        '0xfb72239394647e97894585D0D93Ca91f6C3852a4',
        [
            'function deployExpressProxy(bytes32, address, address, bytes calldata) public returns (address)',
            'function deployedProxyAddress(bytes32,address) public view returns (address)',
            'function isExpressProxy(address) public view returns (bool)',
        ],
        chain.wallet,
    );
    const salt = ethers.utils.formatBytes32String(parseInt(Math.random() * 10000000).toString());
    await chain.expressService.deployExpressProxy(salt, chain.contract.address, wallet.address, '0x').then((tx) => tx.wait());
    const proxyAddress = await chain.expressService.deployedProxyAddress(salt, chain.contract.address);
    console.log(`Deployed Proxy for ${chain.name}`, proxyAddress);
    const gateway = new Contract(chain.gateway, Gateway.abi, chain.wallet);
    const usdcAddress = await gateway.tokenAddresses('aUSDC');
    chain.usdc = new Contract(usdcAddress, IERC20.abi, chain.wallet);
    chain.proxy = new Contract(proxyAddress, ExpressProxy.abi, chain.wallet);
    await chain.proxy.deployRegistry().then(tx => tx.wait());
    // console.log(`Deployed Registry for ${chain.name} at ${await chain.proxy.registry()}.`);
}

async function execute(chains, wallet, options) {
    const args = options.args || [];
    const getGasPrice = options.getGasPrice;
    const source = chains.find((chain) => chain.name === (args[0] || 'Avalanche'));
    const destination = chains.find((chain) => chain.name === (args[1] || 'Fantom'));
    const amount = Math.floor(parseFloat(args[2])) * 1e6 || 10e6;
    const accounts = args.slice(3);

    // check if the proxy is valid
    console.log('source.proxy.address', source.proxy.address)
    // console.log(source.expressService)
    const registry = await source.proxy.registry();
    console.log("registry", registry)
    const validProxySrc = await source.expressService.isExpressProxy(source.proxy.address)
    const validProxyDest = await destination.expressService.isExpressProxy(destination.proxy.address)
    console.log('validProxySrc', validProxySrc)
    console.log('validProxyDest', validProxyDest)
    if(!validProxySrc || !validProxyDest) throw new Error('Invalid proxy address')

    if (accounts.length === 0) accounts.push(wallet.address);

    async function logAccountBalances() {
        for (const account of accounts) {
            console.log(`${account} has ${(await destination.usdc.balanceOf(account)) / 1e6} aUSDC`);
        }
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    console.log('--- Initially ---');
    await logAccountBalances();

    const gasLimit = 3e6;
    const gasPrice = await getGasPrice(source, destination, AddressZero);

    const approveTx = await source.usdc.approve(source.contract.address, amount);
    await approveTx.wait();

    const sendTx = await source.contract.sendToMany(destination.name, destination.proxy.address, accounts, 'aUSDC', amount, {
        value: BigInt(Math.floor(gasLimit * gasPrice)),
    });
    await sendTx.wait();
    console.log('Sent tokens to distribution contract.', sendTx.hash);

    // express call
    const payload = ethers.utils.defaultAbiCoder.encode(['address[]'], [accounts]);

    const approveDestTx = await destination.usdc.approve(destination.proxy.address, amount);
    await approveDestTx.wait();
    console.log('approveDestTx', approveDestTx.hash);
    const tx = await destination.proxy
        .expressExecuteWithToken(source.name, source.proxy.address, payload, 'aUSDC', amount)
        .then((tx) => tx.wait());

    console.log('expressExecuteWithToken', tx.transactionHash);

    console.log('--- After ---');
    await sleep(5000);
    await logAccountBalances();
}

module.exports = {
    deploy,
    execute,
};
