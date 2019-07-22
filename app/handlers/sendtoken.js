const BigNumber = require('bignumber.js');

const utils = require('./utils/utils.js');
const feeutils = require('./utils/fee.js');

const logger = require('../common/logger');
const nothrow = require('../common/nothrow');

const tokens = require("../../config/tokens");


// 发送比特币
async function asyncSendBTC(client, to, amount) {
    // 获取基本信息
    const hot = await utils.asyncGetHotAddress(client);
    const addresses = await utils.asyncGetPaymentAddresses(client);
    let listunspent = await utils.asyncGetUnspentByAddresses(client, addresses);
    listunspent = await utils.asyncGetUnspentWithNoOmniBalance(client, listunspent, tokens.propertyid);

    // 创建输入和输出
    let inputs = [];
    let sum = new BigNumber(0);
    amount = new BigNumber(amount);
    for (let idx in listunspent) {
        const unspent = listunspent[idx];
        sum = sum.plus(new BigNumber(unspent.amount));
        inputs.push({txid: unspent.txid, vout: unspent.vout});
        if (sum.comparedTo(amount) >= 0) {
            break
        }
    }
    if (sum.comparedTo(amount) == -1) {
        listunspent = await utils.asyncGetUnspentByAddresses(client, [hot]);
        for (let idx in listunspent) {
            const unspent = listunspent[idx];
            inputs.push({txid: unspent.txid, vout: unspent.vout});
            sum = sum.plus(new BigNumber(unspent.amount));
            if (sum.comparedTo(amount) >= 0) {
                break
            }
        }
    }

    const output = {};
    output[to] = amount.toString(10);

    // 获取手续费率
    const feeRate = await feeutils.asyncGetFeeRate(client);

    // 创建原始交易
    while (true) {
        let rawtx = await client.createRawTransaction(inputs, output);
        let txsigned = await client.signRawTransaction(rawtx);
        const bytes = parseInt((txsigned.hex.length + 100) / 2);
        const fee = feeutils.calculateFee(bytes, feeRate);
        if (sum.minus(amount).comparedTo(fee) < 0) {
            let count = 0;
            let addamount;
            [listunspent, inputs, addamount, count] = utils.fillTransactionInputs(listunspent, inputs, 1);
            if (count == 0) {
                throw new Error('Insufficient funds');
            }
            sum = sum.plus(new BigNumber(addamount));
            continue;
        }

        rawtx = await client.fundRawTransaction(rawtx, {changeAddress: hot, feeRate: feeRate});
        txsigned = await client.signRawTransaction(rawtx.hex);
        return await client.sendRawTransaction(txsigned.hex);
    }
}

// 发送泰达币
async function asyncSendUSDT(client, to, amount) {
    const address = await utils.asyncGetHotAddress(client);
    const txid = await utils.omni_send(address, to, tokens.propertyid, amount);
    return txid;
}

module.exports = async function(client, req, callback) {
   const rule = [
        {
            name: 'to',
            value: null,
            is_valid: function(address) {
                this.value = address;
                return true;
            }
        },
        {
            name: 'symbol',
            value: null,
            is_valid: function(symbol) {
                symbol = symbol.toUpperCase();
                if (symbol != 'BTC' || symbol != 'USDT') {
                    return false;
                }
                this.value = symbol;
                return true;
            }
        },
        {
            name: 'amount',
            value: null,
            is_valid: function(amount) {
                if (!validator.isFloat(amount)) {
                    return false;
                }
                this.value = amount;
                return true;
            }
        }
    ];
    if (!utils.validationParams(req, rule, callback)) {
        return;
    }

    let error, txid;
    if (rule[1] == 'BTC') {
        [error, txid] = await nothrow(asyncSendBTC(client, rule[0], rule[2]));
    } else if (rule[1] == 'USDT') {
        [error, txid] = await nothrow(asyncSendUSDT(client, rule[0], rule[2]));
    }

    if (error == null) {
        callback(undefined, txid);
        logger.error('send token success, symbol: %s, to: %s, amount: %s, txid: %s',
            rule[1], rule[0], rule[2], txid);
    } else {
        callback({code: -32000, message: error.message}, undefined);
        logger.error('failed to send token, symbol: %s, to: %s, amount: %s, reason: %s',
            rule[1], rule[0], rule[2], error.message);
    }
}
