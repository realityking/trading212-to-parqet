import fs from 'fs/promises';

import { program } from 'commander';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import Decimal from 'decimal.js';

program
  .name('trading212-to-parqet')
  .version('0.0.1')
  .description('Convert Trading 212 CSV files to Parqet CSV files.')
  .argument('<input file>', 'Location of CSV file exported from Trading 212.')
  .argument('<output file>', 'Location Parqet CSV file will be written to.')
  .action(async (inputFile, outputFile) => {
    const input = await fs.readFile(inputFile);

    const { output, errors, countSuccess } = convertCsv(input);
    
    if (countSuccess > 0) {
      await fs.writeFile(outputFile, output);
    }

    console.log(`Mapped ${countSuccess} transactions.`);
    if (errors.length > 0) {
      console.error(`Couldn't map ${errors.length} transactions.`);
      errors.forEach(error => console.error(...error));
    }
  });

program.parseAsync();

const activityMap = {
  'Market buy': 'Buy',
  'Limit buy': 'Buy',
  'Market sell': 'Sell',
  'Limit sell': 'Sell',
  'Stop limit sell': 'Sell',
  'Dividend (Dividend)': 'Dividend',
  'Dividend (Dividend manufactured payment)': 'Dividend'
};

function convertCsv(input) {
  const errors = [];
  const records = parse(input);
  records.shift();

  const parqetRecords = records.map(record => {
    let type = '';
    if (record[0] in activityMap) {
      type = activityMap[record[0]]
    } else {
      errors.push([`Missing activity in activity map: "${record[0]}". Skipping the transcaction`]);
      countFail++;

      return null;
    }

    const shares = new Decimal(record[6]);
    const pricePerShare = record[7];
    const pricePerShareCurrency = record[8];
    const total = record[12];
    const totalCurrency = record[13];
    const witholdingTax = record[14];
    const witholdingTaxCurrency = record[15];
    const conversionFee = record[16];
    const conversionFeeCurrency = record[17];

    let price = ''
    let amount = '';
    let fee = 0;
    let tax = 0;

    if (pricePerShareCurrency === totalCurrency && (witholdingTaxCurrency === totalCurrency || witholdingTaxCurrency === '') && conversionFeeCurrency === '') {
      // Easy case - everything is in one currency
      price = pricePerShare;
      amount = total;
      tax = witholdingTax === '' ? '0' : witholdingTax;
    } else if ((totalCurrency === conversionFeeCurrency || conversionFeeCurrency === '') && witholdingTaxCurrency === '') {
      // Simple conversions without taxes - may or may not include fees
      fee = conversionFee === '' ? '0' : conversionFee;
      price = new Decimal(total).minus(fee).dividedBy(shares);
      amount = total;
    } else if (witholdingTaxCurrency === pricePerShareCurrency && conversionFeeCurrency === '') {
      // Taxation but no currency conversion - usually applies to foreign dividends
      const totalNetBaseCurrency = new Decimal(shares).times(pricePerShare);
      const totalGrossBaseCurrency = totalNetBaseCurrency.plus(witholdingTax);
      const taxRate = new Decimal(witholdingTax).dividedBy(totalGrossBaseCurrency);
      const dAmount = new Decimal(total).dividedBy(new Decimal(1).minus(taxRate)).toDecimalPlaces(2, Decimal.ROUND_HALF_CEIL);

      amount = dAmount.toString();
      tax = dAmount.minus(total).toString();
      price = dAmount.dividedBy(shares).toString();
    } else {
      errors.push(['Currency mix can\'t be mapped. Skipping transaction.', {
        totalCurrency,
        witholdingTaxCurrency,
        pricePerShareCurrency,
        conversionFeeCurrency
      }]);

      return null;
    }

    return {
      datetime: (new Date(record[1])).toISOString(),
      identifier: record[2],
      shares: shares.toString(),
      assetType: 'Security',
      type,
      currency: totalCurrency,
      fee,
      price,
      amount,
      tax
    };
  }).filter(record => record !== null);

  const output = stringify(parqetRecords, {
    header: true
  });

  return {
    output,
    errors,
    countSuccess: parqetRecords.length
  };
}
