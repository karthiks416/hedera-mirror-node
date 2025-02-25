/*
 * Copyright (C) 2020-2024 Hedera Hashgraph, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import _ from 'lodash';

import balances from './balances';
import {getResponseLimit} from './config';
import {
  entityTypes,
  filterKeys,
  httpStatusCodes,
  orderFilterValues,
  responseDataLabel,
  tokenTypeFilter,
} from './constants';
import EntityId from './entityId';
import {InvalidArgumentError, NotFoundError} from './errors';
import {CustomFee, Entity, Nft, NftHistory, NftTransfer, Token, Transaction} from './model';
import {NftService, TokenService} from './service';
import * as utils from './utils';
import {CustomFeeViewModel, NftTransactionHistoryViewModel, NftViewModel} from './viewmodel';

const {default: defaultLimit} = getResponseLimit();

const customFeeSelect = `select jsonb_build_object(
  'created_timestamp', lower(${CustomFee.TIMESTAMP_RANGE}),
  'fixed_fees', ${CustomFee.FIXED_FEES},
  'fractional_fees', ${CustomFee.FRACTIONAL_FEES},
  'royalty_fees', ${CustomFee.ROYALTY_FEES},
  'token_id', ${CustomFee.TOKEN_ID})`;

// select columns
const sqlQueryColumns = {
  DELETED: 'e.deleted',
  KEY: 'e.key',
  PUBLIC_KEY: 'e.public_key',
  SYMBOL: 't.symbol',
  TOKEN_ID: 't.token_id',
  TYPE: 't.type',
};

// query to column maps
const filterColumnMap = {
  publickey: sqlQueryColumns.PUBLIC_KEY,
  symbol: sqlQueryColumns.SYMBOL,
  [filterKeys.TOKEN_ID]: sqlQueryColumns.TOKEN_ID,
  [filterKeys.TOKEN_TYPE]: sqlQueryColumns.TYPE,
};

const nftQueryColumns = {
  ACCOUNT_ID: 'nft.account_id',
  CREATED_TIMESTAMP: 'nft.created_timestamp',
  DELETED: 'nft.deleted',
  SERIAL_NUMBER: 'nft.serial_number',
  TOKEN_ID: 'nft.token_id',
};

// query to column maps
const nftFilterColumnMap = {
  serialnumber: nftQueryColumns.SERIAL_NUMBER,
  [filterKeys.ACCOUNT_ID]: nftQueryColumns.ACCOUNT_ID,
};

const nftSelectFields = [
  'nft.account_id',
  'nft.created_timestamp',
  'nft.delegating_spender',
  'nft.deleted or coalesce(e.deleted, false) as deleted',
  'nft.metadata',
  'nft.serial_number',
  'nft.spender',
  'nft.timestamp_range',
  'nft.token_id',
];
const nftSelectQuery = ['select', nftSelectFields.join(',\n'), 'from nft'].join('\n');
const entityNftsJoinQuery = 'left join entity e on e.id = nft.token_id';

// token discovery sql queries
const tokenAccountCte = `with ta as (
  select *
  from token_account
  where account_id = $1
  order by token_id
)`;
const tokensSelectQuery = `select
    t.decimals,
    t.freeze_status,
    e.key,
    t.kyc_status,
    t.name,
    t.symbol,
    t.token_id,
    t.type
  from token t`;
const entityIdJoinQuery = 'join entity e on e.id = t.token_id';
const tokenAccountJoinQuery = 'join ta on ta.token_id = t.token_id';

// token info sql queries
const tokenInfoSelectFields = [
  'e.auto_renew_account_id',
  'e.auto_renew_period',
  't.created_timestamp',
  'decimals',
  'e.deleted',
  'e.expiration_timestamp',
  'fee_schedule_key',
  'freeze_default',
  'freeze_key',
  'freeze_status',
  'initial_supply',
  'e.key',
  'kyc_key',
  'kyc_status',
  'max_supply',
  'e.memo',
  'lower(t.timestamp_range) as modified_timestamp',
  'name',
  'pause_key',
  'pause_status',
  'supply_key',
  'supply_type',
  'symbol',
  'token_id',
  'total_supply',
  'treasury_account_id',
  't.type',
  'wipe_key',
];
const tokenIdMatchQuery = 'where token_id = $1';

/**
 * Given top level select columns and filters from request query, extract filters and create final sql query with
 * appropriate where clauses.
 */
const extractSqlFromTokenRequest = (query, params, filters, conditions) => {
  // add filters
  let limit = defaultLimit;
  let order = orderFilterValues.ASC;
  const inClause = [];
  conditions = conditions || [];
  for (const filter of filters) {
    if (filter.key === filterKeys.LIMIT) {
      limit = filter.value;
      continue;
    }

    // handle keys that do not require formatting first
    if (filter.key === filterKeys.ORDER) {
      order = filter.value;
      continue;
    }

    // handle token type=ALL, valid param but not present in db
    if (filter.key === filterKeys.TOKEN_TYPE && filter.value === tokenTypeFilter.ALL.toUpperCase()) {
      continue;
    }

    const columnKey = filterColumnMap[filter.key];
    if (columnKey === undefined) {
      continue;
    }

    if (columnKey === sqlQueryColumns.TOKEN_ID && filter.operator === utils.opsMap.eq) {
      inClause.push(filter.value);
      continue;
    }

    conditions.push(`${filterColumnMap[filter.key]}${filter.operator}$${params.push(filter.value)}`);
  }

  if (inClause.length > 0) {
    conditions.push(`${sqlQueryColumns.TOKEN_ID} = any($${params.push(inClause)})`);
  }

  const whereQuery = conditions.length !== 0 ? `where ${conditions.join(' and ')}` : '';
  const orderQuery = `order by ${sqlQueryColumns.TOKEN_ID} ${order}`;
  const limitQuery = `limit $${params.push(limit)}`;
  query = [query, whereQuery, orderQuery, limitQuery].filter((q) => q !== '').join('\n');

  return utils.buildPgSqlObject(query, params, order, limit);
};

/**
 * Format row in postgres query's result to object which is directly returned to user as json.
 */
const formatTokenRow = (row) => {
  return {
    admin_key: utils.encodeKey(row.key),
    name: row.name,
    symbol: row.symbol,
    token_id: EntityId.parse(row.token_id).toString(),
    type: row.type,
    decimals: row.decimals,
  };
};

/**
 * Creates custom fees object from an array of aggregated json objects
 *
 * @param customFee
 * @param tokenType
 * @return {{}|*}
 */
const createCustomFeeObject = (customFee, tokenType) => {
  if (!customFee) {
    return null;
  }

  const model = new CustomFee(customFee);
  const viewModel = new CustomFeeViewModel(model);
  const nonFixedFeesField = tokenType === Token.TYPE.FUNGIBLE_COMMON ? 'fractional_fees' : 'royalty_fees';
  return {
    created_timestamp: utils.nsToSecNs(viewModel.created_timestamp),
    fixed_fees: viewModel.fixed_fees,
    [nonFixedFeesField]: viewModel[nonFixedFeesField],
  };
};

const formatTokenInfoRow = (row) => {
  return {
    admin_key: utils.encodeKey(row.key),
    auto_renew_account: EntityId.parse(row.auto_renew_account_id, {isNullable: true}).toString(),
    auto_renew_period: row.auto_renew_period,
    created_timestamp: utils.nsToSecNs(row.created_timestamp),
    custom_fees: createCustomFeeObject(row.custom_fee, row.type),
    decimals: `${row.decimals}`,
    deleted: row.deleted,
    expiry_timestamp: utils.calculateExpiryTimestamp(
      row.auto_renew_period,
      row.created_timestamp,
      row.expiration_timestamp
    ),
    fee_schedule_key: utils.encodeKey(row.fee_schedule_key),
    freeze_default: row.freeze_default,
    freeze_key: utils.encodeKey(row.freeze_key),
    initial_supply: `${row.initial_supply}`,
    kyc_key: utils.encodeKey(row.kyc_key),
    max_supply: `${row.max_supply}`,
    memo: row.memo,
    modified_timestamp: utils.nsToSecNs(row.modified_timestamp),
    name: row.name,
    pause_key: utils.encodeKey(row.pause_key),
    pause_status: row.pause_status,
    supply_key: utils.encodeKey(row.supply_key),
    supply_type: row.supply_type,
    symbol: row.symbol,
    token_id: EntityId.parse(row.token_id).toString(),
    total_supply: `${row.total_supply}`,
    treasury_account_id: EntityId.parse(row.treasury_account_id).toString(),
    type: row.type,
    wipe_key: utils.encodeKey(row.wipe_key),
  };
};

const validateTokenQueryFilter = (param, op, val) => {
  let ret = false;

  if (op === undefined || val === undefined) {
    return ret;
  }

  // Validate operator
  if (!utils.isValidOperatorQuery(op)) {
    return ret;
  }

  // Validate the value
  switch (param) {
    case filterKeys.ACCOUNT_ID:
      ret = EntityId.isValidEntityId(val);
      break;
    case filterKeys.ENTITY_PUBLICKEY:
      // Acceptable forms: exactly 64 characters or +12 bytes (DER encoded)
      ret = utils.isValidPublicKeyQuery(val);
      break;
    case filterKeys.LIMIT:
      ret = utils.isPositiveLong(val);
      break;
    case filterKeys.ORDER:
      // Acceptable words: asc or desc
      ret = utils.isValidValueIgnoreCase(val, Object.values(orderFilterValues));
      break;
    case filterKeys.SERIAL_NUMBER:
      ret = utils.isPositiveLong(val);
      break;
    case filterKeys.TOKEN_ID:
      ret = EntityId.isValidEntityId(val, false);
      break;
    case filterKeys.TOKEN_TYPE:
      ret = utils.isValidValueIgnoreCase(val, Object.values(tokenTypeFilter));
      break;
    case filterKeys.TIMESTAMP:
      ret = utils.isValidTimestampParam(val);
      break;
    default:
      // Every token parameter should be included here. Otherwise, it will not be accepted.
      break;
  }

  return ret;
};

const getTokensRequest = async (req, res) => {
  // validate filters, use custom check for tokens until validateAndParseFilters is optimized to handle
  // per resource unique param names
  const filters = utils.buildAndValidateFilters(req.query, acceptedTokenParameters, validateTokenQueryFilter);

  const conditions = [];
  const getTokensSqlQuery = [tokensSelectQuery];
  const getTokenSqlParams = [];

  // if account.id filter is present join on token_account and filter dissociated tokens
  const accountId = req.query[filterKeys.ACCOUNT_ID];
  if (accountId) {
    conditions.push('ta.associated is true');
    getTokensSqlQuery.unshift(tokenAccountCte);
    getTokensSqlQuery.push(tokenAccountJoinQuery);
    getTokenSqlParams.push(EntityId.parse(accountId, {paramName: filterKeys.ACCOUNT_ID}).getEncodedId());
  }

  // add join with entities table to sql query
  getTokensSqlQuery.push(entityIdJoinQuery);

  // build final sql query
  const {query, params, order, limit} = extractSqlFromTokenRequest(
    getTokensSqlQuery.join('\n'),
    getTokenSqlParams,
    filters,
    conditions
  );

  const rows = await getTokens(query, params);
  const tokens = rows.map((r) => {
    TokenService.putTokenCache(r);
    return formatTokenRow(r);
  });

  // populate next link
  const lastTokenId = tokens.length > 0 ? tokens[tokens.length - 1].token_id : null;
  const nextLink = utils.getPaginationLink(
    req,
    tokens.length !== limit,
    {
      [filterKeys.TOKEN_ID]: lastTokenId,
    },
    order
  );

  res.locals[responseDataLabel] = {
    tokens,
    links: {
      next: nextLink,
    },
  };
};

const getAndValidateTokenIdRequestPathParam = (req) => {
  return EntityId.parse(req.params.tokenId, {allowEvmAddress: false, paramName: filterKeys.TOKENID}).getEncodedId();
};

/**
 * Validates the token info timestamp filter operator.
 *
 * @param {string} op
 * @return {boolean}
 */
const isValidTokenInfoTimestampFilterOp = (op) => {
  return op === 'eq' || op === 'lt' || op === 'lte';
};

/**
 * Validates token info request filters. Only timestamp filter is supported.
 *
 * @param param
 * @param op
 * @param val
 * @return {boolean}
 */
const validateTokenInfoFilter = (param, op, val) => {
  let ret = false;

  if (op === undefined || val === undefined) {
    return ret;
  }

  if (param === filterKeys.TIMESTAMP) {
    ret = isValidTokenInfoTimestampFilterOp(op) && utils.isValidTimestampParam(val);
  }

  return ret;
};

/**
 * Transforms the timestamp filter operator: '=' maps to '<=', others stay the same
 *
 * @param {string} op
 */
const transformTimestampFilterOp = (op) => {
  const {opsMap} = utils;
  return op === opsMap.eq ? opsMap.lte : op;
};

/**
 * Gets the token info query
 *
 * @param {string} tokenId
 * @param {[]} filters
 * @return {{query: string, params: []}} the query string and params
 */
const extractSqlFromTokenInfoRequest = (tokenId, filters) => {
  const conditions = [`${CustomFee.TOKEN_ID} = $1`];
  const params = [tokenId];
  let customFeeQuery;

  if (filters && filters.length !== 0) {
    // honor the last timestamp filter
    const filter = filters[filters.length - 1];
    const op = transformTimestampFilterOp(filter.operator);
    conditions.push(`lower(${CustomFee.TIMESTAMP_RANGE}) ${op} $2`);
    params.push(filter.value);

    // include the history table in the query
    customFeeQuery = `
      ${customFeeSelect}
      from
      (
        (select *, lower(${CustomFee.TIMESTAMP_RANGE}) as created_timestamp
         from ${CustomFee.tableName}
         where ${conditions.join(' and ')})
        union all
        (select *, lower(${CustomFee.TIMESTAMP_RANGE}) as created_timestamp
         from ${CustomFee.tableName}_history 
         where ${conditions.join(' and ')} order by lower(${CustomFee.TIMESTAMP_RANGE}) desc limit 1)
        order by created_timestamp desc
        limit 1
      ) as feeAndHistory`;
  } else {
    customFeeQuery = `
      ${customFeeSelect}
      from ${CustomFee.tableName}
      where ${conditions.join(' and ')}`;
  }

  const query = [
    'select',
    [...tokenInfoSelectFields, `(${customFeeQuery}) as custom_fee`].join(',\n'),
    'from token t',
    entityIdJoinQuery,
    tokenIdMatchQuery,
  ].join('\n');

  return {
    query,
    params,
  };
};

const getTokenInfoRequest = async (req, res) => {
  const tokenId = getAndValidateTokenIdRequestPathParam(req);

  // extract and validate filters from query param
  const filters = utils.buildAndValidateFilters(req.query, acceptedSingleTokenParameters, validateTokenInfoFilter);
  const {query, params} = extractSqlFromTokenInfoRequest(tokenId, filters);

  const {rows} = await pool.queryQuietly(query, params);
  if (rows.length !== 1 || !rows[0].custom_fee) {
    throw new NotFoundError();
  }

  const token = rows[0];
  TokenService.putTokenCache(token);
  res.locals[responseDataLabel] = formatTokenInfoRow(token);
};

const getTokens = async (pgSqlQuery, pgSqlParams) => {
  const {rows} = await pool.queryQuietly(pgSqlQuery, pgSqlParams);
  logger.debug(`getTokens returning ${rows.length} entries`);
  return rows;
};

// token balances select columns
const tokenBalancesSqlQueryColumns = {
  ACCOUNT_BALANCE: 'ti.balance',
  ACCOUNT_ID: 'ti.account_id',
  CONSENSUS_TIMESTAMP: 'ti.consensus_timestamp',
  ACCOUNT_PUBLICKEY: 'e.public_key',
  TOKEN_ID: 'ti.token_id',
};

/**
 * Extracts SQL query, params, order, and limit
 *
 * @param {string} tokenId encoded token ID
 * @param {[]} filters parsed and validated filters
 * @return {{query: string, limit: number, params: [], order: 'asc'|'desc'}}
 */
const extractSqlFromTokenBalancesRequest = async (tokenId, filters) => {
  const balanceConditions = [];
  const conditions = [`${tokenBalancesSqlQueryColumns.TOKEN_ID} = $1`];
  let limit = defaultLimit;
  let order = orderFilterValues.DESC;
  const params = [tokenId];
  let publicKey;
  const tsConditions = [];
  const tsParams = [];

  for (const filter of filters) {
    switch (filter.key) {
      case filterKeys.ACCOUNT_ID:
        conditions.push(`${tokenBalancesSqlQueryColumns.ACCOUNT_ID} ${filter.operator} $${params.push(filter.value)}`);
        break;
      case filterKeys.ACCOUNT_BALANCE:
        balanceConditions.push(
          `${tokenBalancesSqlQueryColumns.ACCOUNT_BALANCE} ${filter.operator} $${params.push(filter.value)}`
        );
        break;
      case filterKeys.ACCOUNT_PUBLICKEY:
        // honor the last public key filter
        publicKey = filter.value;
        break;
      case filterKeys.LIMIT:
        limit = filter.value;
        break;
      case filterKeys.ORDER:
        order = filter.value;
        break;
      case filterKeys.TIMESTAMP:
        const op = transformTimestampFilterOp(filter.operator);
        tsParams.push(filter.value);
        // balances.getAccountBalanceTimestampRange only supports MySQL style placeholders
        tsConditions.push(`${tokenBalancesSqlQueryColumns.CONSENSUS_TIMESTAMP} ${op} ?`);
        break;
      default:
        break;
    }
  }

  const joinEntityClause = publicKey
    ? `join entity as e
      on e.type = '${entityTypes.ACCOUNT}' and
        e.id = ${tokenBalancesSqlQueryColumns.ACCOUNT_ID} and
        ${tokenBalancesSqlQueryColumns.ACCOUNT_PUBLICKEY} = $${params.push(publicKey)}`
    : '';

  let query;
  if (tsConditions.length) {
    const tsQuery = tsConditions.join(' and ');
    const {lower, upper} = await balances.getAccountBalanceTimestampRange(tsQuery, tsParams);
    if (lower === undefined) {
      return {};
    }

    conditions.push(
      `${tokenBalancesSqlQueryColumns.CONSENSUS_TIMESTAMP} >= $${params.push(lower)}`,
      `${tokenBalancesSqlQueryColumns.CONSENSUS_TIMESTAMP} <= $${params.push(upper)}`
    );
    query = `select
        distinct on (ti.account_id)
        ti.account_id,
        ti.balance,
        $${params.length}::bigint as consensus_timestamp
      from token_balance as ti
      ${joinEntityClause}
      where ${conditions.join(' and ')}
      order by ti.account_id ${order}, ti.consensus_timestamp desc`;
    if (balanceConditions.length) {
      // Apply balance filter after retrieving the latest balance as of the upper timestamp
      query = `with ti as (${query})
        select *
        from ti
        where ${balanceConditions.join(' and ')}
        order by account_id ${order}`;
    }
    query += `\nlimit $${params.push(limit)}`;
  } else {
    conditions.push('ti.associated = true');
    if (balanceConditions.length) {
      conditions.push(...balanceConditions);
    }

    query = `
      with filtered_token_accounts as (
        select ti.account_id, ti.balance, ti.balance_timestamp
          from token_account as ti
          ${joinEntityClause}
          where ${conditions.join(' and ')}
          order by ti.account_id ${order}
          limit $${params.push(limit)}
      )
      select 
        tif.account_id,
        tif.balance,
        (select MAX(balance_timestamp) from filtered_token_accounts) as consensus_timestamp
      from filtered_token_accounts as tif`;
  }

  return utils.buildPgSqlObject(query, params, order, limit);
};

const formatTokenBalanceRow = (row, decimals) => {
  return {
    account: EntityId.parse(row.account_id).toString(),
    balance: row.balance,
    decimals,
  };
};

/**
 * Handler function for /tokens/:tokenId/balances API.
 *
 * @param {Request} req HTTP request object
 * @param {Response} res HTTP response object
 */
const getTokenBalances = async (req, res) => {
  const tokenId = getAndValidateTokenIdRequestPathParam(req);
  const filters = utils.buildAndValidateFilters(req.query, acceptedTokenBalancesParameters);

  const response = {
    timestamp: null,
    balances: [],
    links: {
      next: null,
    },
  };
  res.locals[responseDataLabel] = response;

  const {query, params, limit, order} = await extractSqlFromTokenBalancesRequest(tokenId, filters);
  if (query === undefined) {
    return;
  }

  const {rows} = await pool.queryQuietly(query, params);
  if (rows.length > 0) {
    const cachedTokens = await TokenService.getCachedTokens(new Set([tokenId]));
    const decimals = cachedTokens.get(tokenId)?.decimals ?? null;
    response.balances = rows.map((row) => formatTokenBalanceRow(row, decimals));
    response.timestamp = utils.nsToSecNs(rows[0].consensus_timestamp);

    const anchorAccountId = response.balances[response.balances.length - 1].account;
    response.links.next = utils.getPaginationLink(
      req,
      response.balances.length !== limit,
      {
        [filterKeys.ACCOUNT_ID]: anchorAccountId,
      },
      order
    );
  }

  logger.debug(`getTokenBalances returning ${response.balances.length} entries`);
};

/**
 * Extracts SQL query, params, order, and limit
 *
 * @param {string} tokenId encoded token ID
 * @param {string} query initial pg SQL query string
 * @param {[]} filters parsed and validated filters
 * @return {{query: string, limit: number, params: [], order: 'asc'|'desc'}}
 */
const extractSqlFromNftTokensRequest = (tokenId, query, filters) => {
  let limit = defaultLimit;
  let order = orderFilterValues.DESC;
  const conditions = [`${nftQueryColumns.TOKEN_ID} = $1`];
  const params = [tokenId];

  for (const filter of filters) {
    switch (filter.key) {
      case filterKeys.LIMIT:
        limit = filter.value;
        break;
      case filterKeys.ORDER:
        order = filter.value;
        break;
      default:
        const columnKey = nftFilterColumnMap[filter.key];
        if (!columnKey) {
          break;
        }

        conditions.push(`${columnKey} ${filter.operator} $${params.push(filter.value)}`);
        break;
    }
  }

  const whereQuery = `where ${conditions.join('\nand ')}`;
  const orderQuery = `order by ${nftQueryColumns.SERIAL_NUMBER} ${order}`;
  const limitQuery = `limit $${params.push(limit)}`;
  query = [query, entityNftsJoinQuery, whereQuery, orderQuery, limitQuery].filter((q) => q !== '').join('\n');

  return utils.buildPgSqlObject(query, params, order, limit);
};

/**
 * Extracts SQL query, params, order, and limit
 *
 * @param {string} tokenId encoded token ID
 * @param {string} serialNumber nft serial number
 * @param {string} query initial pg SQL query string
 * @return {{query: string, limit: number, params: [], order: 'asc'|'desc'}}
 */
const extractSqlFromNftTokenInfoRequest = (tokenId, serialNumber, query) => {
  // filter for token and serialNumber
  const conditions = [`${nftQueryColumns.TOKEN_ID} = $1`, `${nftQueryColumns.SERIAL_NUMBER} = $2`];
  const params = [tokenId, serialNumber];

  const whereQuery = `where ${conditions.join('\nand ')}`;
  query = [query, entityNftsJoinQuery, whereQuery].filter((q) => q !== '').join('\n');

  return utils.buildPgSqlObject(query, params, '', '');
};

/**
 * Verify serialnumber meets expected integer format and range
 */
const validateSerialNumberParam = (serialNumber) => {
  if (!utils.isPositiveLong(serialNumber)) {
    throw InvalidArgumentError.forParams(filterKeys.SERIAL_NUMBER);
  }
};

const getAndValidateSerialNumberRequestPathParam = (req) => {
  const {serialNumber} = req.params;
  validateSerialNumberParam(serialNumber);
  return utils.parseInteger(serialNumber);
};

/**
 * Handler function for /tokens/:tokenId/nfts API.
 *
 * @param {Request} req HTTP request object
 * @param {Response} res HTTP response object
 */
const getNftTokensRequest = async (req, res) => {
  const tokenId = getAndValidateTokenIdRequestPathParam(req);
  const filters = utils.buildAndValidateFilters(req.query, acceptedNftsParameters, validateTokenQueryFilter);

  const {query, params, limit, order} = extractSqlFromNftTokensRequest(tokenId, nftSelectQuery, filters);
  const {rows} = await pool.queryQuietly(query, params);
  const response = {
    nfts: [],
    links: {
      next: null,
    },
  };

  response.nfts = rows.map((row) => {
    const nftModel = new Nft(row);
    return new NftViewModel(nftModel);
  });

  // Pagination links
  const anchorSerialNumber = response.nfts.length > 0 ? response.nfts[response.nfts.length - 1].serial_number : 0;
  response.links.next = utils.getPaginationLink(
    req,
    response.nfts.length !== limit,
    {
      [filterKeys.SERIAL_NUMBER]: anchorSerialNumber,
    },
    order
  );

  logger.debug(`getNftTokens returning ${response.nfts.length} entries`);
  res.locals[responseDataLabel] = response;
};

/**
 * Handler function for /tokens/:tokenId/nfts/:serialNumber API.
 *
 * @param {Request} req HTTP request object
 * @param {Response} res HTTP response object
 */
const getNftTokenInfoRequest = async (req, res) => {
  utils.validateReq(req);
  const tokenId = getAndValidateTokenIdRequestPathParam(req);
  const serialNumber = getAndValidateSerialNumberRequestPathParam(req);

  const {query, params} = extractSqlFromNftTokenInfoRequest(tokenId, serialNumber, nftSelectQuery);
  const {rows} = await pool.queryQuietly(query, params);
  if (rows.length !== 1) {
    throw new NotFoundError();
  }

  logger.debug(`getNftToken info returning single entry`);
  const nftModel = new Nft(rows[0]);
  res.locals[responseDataLabel] = new NftViewModel(nftModel);
};

const nftTransactionHistorySelectFields = [
  Transaction.CONSENSUS_TIMESTAMP,
  `(select jsonb_path_query_array(
    ${Transaction.NFT_TRANSFER},
    '$[*] ? (@.token_id == $token_id && @.serial_number == $serial_number)',
    $1)
  ) as nft_transfer`,
  Transaction.NONCE,
  Transaction.PAYER_ACCOUNT_ID,
  Transaction.TYPE,
  Transaction.VALID_START_NS,
].join(',\n');

/**
 * Extracts SQL query, params, order, and limit
 * Combine NFT transfers (mint, transfer, wipe account, burn) details from nft_transfer with DELETION details from nft
 *
 * @param {BigInt|Number} tokenId encoded token ID
 * @param {string} serialNumber nft serial number
 * @param {[]} filters parsed and validated filters
 * @return {{query: string, limit: number, params: [], order: 'asc'|'desc'}}
 */
const extractSqlFromNftTransferHistoryRequest = (tokenId, serialNumber, filters) => {
  let limit = defaultLimit;
  let order = orderFilterValues.DESC;

  // The first parameter is for jsonb_path_query_array, stringify it since otherwise the driver will use JSON.stringify
  // without BigInt support
  const jsonbPathQueryVars = utils.JSONStringify({token_id: tokenId, serial_number: serialNumber});
  const params = [jsonbPathQueryVars, tokenId, serialNumber];
  // if the nft token class is deleted, the lower of the timestamp_range is the consensus timestamp of the token
  // delete transaction
  const tokenDeleteTimestampQuery = `select lower(${Entity.TIMESTAMP_RANGE})
                                     from ${Entity.tableName}
                                     where ${Entity.ID} = $2
                                       and ${Entity.DELETED} is true`;
  const tokenDeleteConditions = [`${Transaction.CONSENSUS_TIMESTAMP} = (${tokenDeleteTimestampQuery})`];
  const nftConditions = [`${Nft.TOKEN_ID} = $2`, `${Nft.SERIAL_NUMBER} = $3`];

  // add applicable filters
  const nftLowerTimestamp = `lower(${Nft.TIMESTAMP_RANGE})`;
  for (const filter of filters) {
    switch (filter.key) {
      case filterKeys.LIMIT:
        limit = filter.value;
        break;
      case filterKeys.ORDER:
        order = filter.value;
        break;
      case filterKeys.TIMESTAMP:
        const paramCount = params.push(filter.value);
        nftConditions.push(`${nftLowerTimestamp} ${filter.operator} $${paramCount}`);
        tokenDeleteConditions.push(`${Transaction.CONSENSUS_TIMESTAMP} ${filter.operator} $${paramCount}`);
        break;
      default:
        break;
    }
  }

  // the query planner may not be able to push the limit in the main query to the cte, thus adding the order and limit
  // here to optimize the performance for nfts with a lot of transfers
  params.push(limit);
  const limitQuery = `limit $${params.length}`;
  const nftConditionsClause = `where ${nftConditions.join(' and ')}`;

  const query = `with nft_event as (
    select ${nftLowerTimestamp} as timestamp
    from ${Nft.tableName}
    ${nftConditionsClause}
    union all
    select ${nftLowerTimestamp} as timestamp
    from ${NftHistory.tableName}
    ${nftConditionsClause}
    order by timestamp ${order}
    ${limitQuery}
  ), nft_transaction as (
    select ${nftTransactionHistorySelectFields}
    from ${Transaction.tableName}
    join nft_event on timestamp = ${Transaction.CONSENSUS_TIMESTAMP}
  ), token_deletion as (
    select
      ${Transaction.CONSENSUS_TIMESTAMP},
      jsonb_build_array(jsonb_build_object(
        '${NftTransfer.IS_APPROVAL}', false,
        '${NftTransfer.RECEIVER_ACCOUNT_ID}', null,
        '${NftTransfer.SENDER_ACCOUNT_ID}', null,
        '${NftTransfer.SERIAL_NUMBER}', $3,
        '${NftTransfer.TOKEN_ID}', $2
      )) as nft_transfer,
      ${Transaction.NONCE},
      ${Transaction.PAYER_ACCOUNT_ID},
      ${Transaction.TYPE},
      ${Transaction.VALID_START_NS}
    from ${Transaction.tableName}
    where ${tokenDeleteConditions.join(' and ')}
  )
  select * from nft_transaction
  union all
  select * from token_deletion
  order by ${Transaction.CONSENSUS_TIMESTAMP} ${order}
  ${limitQuery}`;

  return utils.buildPgSqlObject(query, params, order, limit);
};

const formatNftHistoryRow = (row) => {
  const transactionModel = new Transaction(row);
  return new NftTransactionHistoryViewModel(transactionModel);
};

/**
 * Handler function for /api/v1/tokens/{tokenId}/nfts/{serialNumber}/transactions API.
 *
 * @param {Request} req HTTP request object
 * @param {Response} res HTTP response object
 */
const getNftTransferHistoryRequest = async (req, res) => {
  const tokenId = getAndValidateTokenIdRequestPathParam(req);
  const serialNumber = getAndValidateSerialNumberRequestPathParam(req);

  const filters = utils.buildAndValidateFilters(
    req.query,
    acceptedNftTransferHistoryParameters,
    validateTokenQueryFilter
  );

  const {query, params, limit, order} = extractSqlFromNftTransferHistoryRequest(tokenId, serialNumber, filters);
  const {rows} = await pool.queryQuietly(query, params);
  const response = {
    transactions: rows.map(formatNftHistoryRow),
    links: {
      next: null,
    },
  };

  // Pagination links
  const anchorTimestamp = _.last(response.transactions)?.consensus_timestamp ?? 0;
  response.links.next = utils.getPaginationLink(
    req,
    response.transactions.length !== limit,
    {
      [filterKeys.TIMESTAMP]: anchorTimestamp,
    },
    order
  );

  logger.debug(`getNftTransferHistory returning ${response.transactions.length} entries`);
  res.locals[responseDataLabel] = response;

  if (response.transactions.length > 0) {
    // check if nft exists
    const nft = await NftService.getNft(tokenId, serialNumber);
    if (nft?.createdTimestamp == null) {
      // set 206 partial response
      res.locals.statusCode = httpStatusCodes.PARTIAL_CONTENT.code;
      logger.debug(`getNftTransferHistory returning partial content`);
    }
  }
};

const tokens = {
  getNftTokenInfoRequest,
  getNftTokensRequest,
  getNftTransferHistoryRequest,
  getTokenBalances,
  getTokenInfoRequest,
  getTokensRequest,
};

const acceptedNftsParameters = new Set([
  filterKeys.ACCOUNT_ID,
  filterKeys.LIMIT,
  filterKeys.ORDER,
  filterKeys.SERIAL_NUMBER,
]);

const acceptedNftTransferHistoryParameters = new Set([filterKeys.LIMIT, filterKeys.ORDER, filterKeys.TIMESTAMP]);

const acceptedTokenParameters = new Set([
  filterKeys.ACCOUNT_ID,
  filterKeys.ENTITY_PUBLICKEY,
  filterKeys.LIMIT,
  filterKeys.ORDER,
  filterKeys.TOKEN_ID,
  filterKeys.TOKEN_TYPE,
]);

const acceptedSingleTokenParameters = new Set([filterKeys.TIMESTAMP]);

const acceptedTokenBalancesParameters = new Set([
  filterKeys.ACCOUNT_ID,
  filterKeys.ACCOUNT_BALANCE,
  filterKeys.ACCOUNT_PUBLICKEY,
  filterKeys.LIMIT,
  filterKeys.ORDER,
  filterKeys.TIMESTAMP,
]);

if (utils.isTestEnv()) {
  Object.assign(tokens, {
    entityIdJoinQuery,
    extractSqlFromNftTokenInfoRequest,
    extractSqlFromNftTokensRequest,
    extractSqlFromNftTransferHistoryRequest,
    extractSqlFromTokenBalancesRequest,
    extractSqlFromTokenInfoRequest,
    extractSqlFromTokenRequest,
    formatNftHistoryRow,
    formatTokenBalanceRow,
    formatTokenInfoRow,
    formatTokenRow,
    nftSelectQuery,
    tokenAccountCte,
    tokenAccountJoinQuery,
    tokensSelectQuery,
    validateSerialNumberParam,
    validateTokenInfoFilter,
    validateTokenQueryFilter,
  });
}

export default tokens;
