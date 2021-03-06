/**
 * InMemoryProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for a non-persisted in-memory database backing provider.
 */
import 'core-js/features/set-immediate';
import { attempt, isError, each, includes, compact, map, find, Dictionary, flatten, assign, filter, keys, reverse } from 'lodash';

import { DbIndexFTSFromRangeQueries, getFullTextIndexWordsForItem } from './FullTextSearchHelpers';
import {
    StoreSchema, DbProvider, DbSchema, DbTransaction,
    DbIndex, IndexSchema, DbStore, QuerySortOrder, ItemType, KeyPathType, KeyType
} from './NoSqlProvider';
import {
    arrayify, serializeKeyToString, formListOfSerializedKeys,
    getSerializedKeyForKeypath, getValueForSingleKeypath
} from './NoSqlProviderUtils';
import { TransactionLockHelper, TransactionToken } from './TransactionLockHelper';

export interface StoreData {
    data: Dictionary<ItemType>;
    schema: StoreSchema;
}

let asyncCallbacks: Set<() => void> = new Set();

/**
 * This function will defer callback of the specified callback lambda until the next JS tick, simulating standard A+ promise behavior
 */
function asyncCallback(callback: () => void): void {
    asyncCallbacks.add(callback);

    if (asyncCallbacks.size === 1) {
        setImmediate(resolveAsyncCallbacks);
    }
}

function abortAsyncCallback(callback: () => void): void {
    asyncCallbacks.delete(callback);
}

function resolveAsyncCallbacks(): void {
    const savedCallbacks = asyncCallbacks;
    asyncCallbacks = new Set();
    savedCallbacks.forEach((item) => item());
}

// Very simple in-memory dbprovider for handling IE inprivate windows (and unit tests, maybe?)
export class InMemoryProvider extends DbProvider {
    private _stores: { [storeName: string]: StoreData } = {};

    private _lockHelper: TransactionLockHelper | undefined;

    open(dbName: string, schema: DbSchema, wipeIfExists: boolean, verbose: boolean): Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);

        each(this._schema!!!.stores, storeSchema => {
            this._stores[storeSchema.name] = { schema: storeSchema, data: {} };
        });

        this._lockHelper = new TransactionLockHelper(schema, true);

        return Promise.resolve<void>(undefined);
    }

    protected _deleteDatabaseInternal() {
        return Promise.resolve();
    }

    openTransaction(storeNames: string[], writeNeeded: boolean): Promise<DbTransaction> {
        return this._lockHelper!!!.openTransaction(storeNames, writeNeeded).then(token =>
            new InMemoryTransaction(this, this._lockHelper!!!, token));
    }

    close(): Promise<void> {
        return this._lockHelper!!!.closeWhenPossible().then(() => {
            this._stores = {};
        });
    }

    internal_getStore(name: string): StoreData {
        return this._stores[name];
    }
}

// Notes: Doesn't limit the stores it can fetch to those in the stores it was "created" with, nor does it handle read-only transactions
class InMemoryTransaction implements DbTransaction {
    private _stores: Dictionary<InMemoryStore> = {};
    private _transactionCallback?: () => void;
    constructor(
        private _prov: InMemoryProvider,
        private _lockHelper: TransactionLockHelper,
        private _transToken: TransactionToken) {
        this._transactionCallback = () => {
            this._commitTransaction();
            this._lockHelper.transactionComplete(this._transToken);
            this._transactionCallback = undefined;
        };
        // Close the transaction on the next tick.  By definition, anything is completed synchronously here, so after an event tick
        // goes by, there can't have been anything pending.   
        asyncCallback(this._transactionCallback);
    }

    private _commitTransaction(): void {
        each(this._stores, store => {
            store.internal_commitPendingData();
        });
    }

    getCompletionPromise(): Promise<void> {
        return this._transToken.completionPromise;
    }

    abort(): void {
        each(this._stores, store => {
            store.internal_rollbackPendingData();
        });
        this._stores = {};

        if (this._transactionCallback) {
            abortAsyncCallback(this._transactionCallback);
            this._transactionCallback = undefined;
        }

        this._lockHelper.transactionFailed(this._transToken, 'InMemoryTransaction Aborted');
    }

    markCompleted(): void {
        // noop
    }

    getStore(storeName: string): DbStore {
        if (!includes(arrayify(this._transToken.storeNames), storeName)) {
            throw new Error('Store not found in transaction-scoped store list: ' + storeName);
        }
        if (this._stores[storeName]) {
            return this._stores[storeName];
        }
        const store = this._prov.internal_getStore(storeName);
        if (!store) {
            throw new Error('Store not found: ' + storeName);
        }
        const ims = new InMemoryStore(this, store);
        this._stores[storeName] = ims;
        return ims;
    }

    internal_isOpen() {
        return !!this._transactionCallback;
    }
}

class InMemoryStore implements DbStore {
    private _pendingCommitDataChanges: Dictionary<ItemType | undefined> | undefined;

    private _committedStoreData: Dictionary<ItemType>;
    private _mergedData: Dictionary<ItemType>;
    private _storeSchema: StoreSchema;

    constructor(private _trans: InMemoryTransaction, storeInfo: StoreData) {
        this._storeSchema = storeInfo.schema;
        this._committedStoreData = storeInfo.data;

        this._mergedData = this._committedStoreData;
    }

    private _checkDataClone(): void {
        if (!this._pendingCommitDataChanges) {
            this._pendingCommitDataChanges = {};
            this._mergedData = assign({}, this._committedStoreData);
        }
    }

    internal_commitPendingData(): void {
        each(this._pendingCommitDataChanges, (val, key) => {
            if (val === undefined) {
                delete this._committedStoreData[key];
            } else {
                this._committedStoreData[key] = val;
            }
        });

        this._pendingCommitDataChanges = undefined;
        this._mergedData = this._committedStoreData;
    }

    internal_rollbackPendingData(): void {
        this._pendingCommitDataChanges = undefined;
        this._mergedData = this._committedStoreData;
    }

    get(key: KeyType): Promise<ItemType | undefined> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }

        const joinedKey = attempt(() => {
            return serializeKeyToString(key, this._storeSchema.primaryKeyPath);
        });
        if (isError(joinedKey)) {
            return Promise.reject(joinedKey);
        }

        return Promise.resolve(this._mergedData[joinedKey]);
    }

    getMultiple(keyOrKeys: KeyType | KeyType[]): Promise<ItemType[]> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }

        const joinedKeys = attempt(() => {
            return formListOfSerializedKeys(keyOrKeys, this._storeSchema.primaryKeyPath);
        });
        if (isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }

        return Promise.resolve(compact(map(joinedKeys, key => this._mergedData[key])));
    }

    put(itemOrItems: ItemType | ItemType[]): Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject<void>('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        const err = attempt(() => {
            for (const item of arrayify(itemOrItems)) {
                let pk = getSerializedKeyForKeypath(item, this._storeSchema.primaryKeyPath)!!!;

                this._pendingCommitDataChanges!!![pk] = item;
                this._mergedData[pk] = item;
            }
        });
        if (err) {
            return Promise.reject<void>(err);
        }
        return Promise.resolve<void>(undefined);
    }

    remove(keyOrKeys: KeyType | KeyType[]): Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject<void>('InMemoryTransaction already closed');
        }
        this._checkDataClone();

        const joinedKeys = attempt(() => {
            return formListOfSerializedKeys(keyOrKeys, this._storeSchema.primaryKeyPath);
        });
        if (isError(joinedKeys)) {
            return Promise.reject(joinedKeys);
        }

        for (const key of joinedKeys) {
            this._pendingCommitDataChanges!!![key] = undefined;
            delete this._mergedData[key];
        }
        return Promise.resolve<void>(undefined);
    }

    openPrimaryKey(): DbIndex {
        this._checkDataClone();
        return new InMemoryIndex(this._trans, this._mergedData, undefined, this._storeSchema.primaryKeyPath);
    }

    openIndex(indexName: string): DbIndex {
        let indexSchema = find(this._storeSchema.indexes, idx => idx.name === indexName);
        if (!indexSchema) {
            throw new Error('Index not found: ' + indexName);
        }

        this._checkDataClone();
        return new InMemoryIndex(this._trans, this._mergedData, indexSchema, this._storeSchema.primaryKeyPath);
    }

    clearAllData(): Promise<void> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject<void>('InMemoryTransaction already closed');
        }
        this._checkDataClone();
        each(this._mergedData, (val, key) => {
            this._pendingCommitDataChanges!!![key] = undefined;
        });
        this._mergedData = {};
        return Promise.resolve<void>(undefined);
    }
}

// Note: Currently maintains nothing interesting -- rebuilds the results every time from scratch.  Scales like crap.
class InMemoryIndex extends DbIndexFTSFromRangeQueries {
    constructor(private _trans: InMemoryTransaction, private _mergedData: Dictionary<ItemType>,
        indexSchema: IndexSchema | undefined, primaryKeyPath: KeyPathType) {
        super(indexSchema, primaryKeyPath);
    }

    // Warning: This function can throw, make sure to trap.
    private _calcChunkedData(): Dictionary<ItemType[]> | Dictionary<ItemType> {
        if (!this._indexSchema) {
            // Primary key -- use data intact
            return this._mergedData;
        }

        // If it's not the PK index, re-pivot the data to be keyed off the key value built from the keypath
        let data: Dictionary<ItemType[]> = {};
        each(this._mergedData, item => {
            // Each item may be non-unique so store as an array of items for each key
            let keys: string[];
            if (this._indexSchema!!!.fullText) {
                keys = map(getFullTextIndexWordsForItem(<string>this._keyPath, item), val =>
                    serializeKeyToString(val, <string>this._keyPath));
            } else if (this._indexSchema!!!.multiEntry) {
                // Have to extract the multiple entries into this alternate table...
                const valsRaw = getValueForSingleKeypath(item, <string>this._keyPath);
                if (valsRaw) {
                    keys = map(arrayify(valsRaw), val =>
                        serializeKeyToString(val, <string>this._keyPath));
                } else {
                    keys = [];
                }
            } else {
                keys = [getSerializedKeyForKeypath(item, this._keyPath)!!!];
            }

            for (const key of keys) {
                if (!data[key]) {
                    data[key] = [item];
                } else {
                    data[key].push(item);
                }
            }
        });
        return data;
    }

    getAll(reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }

        const data = attempt(() => {
            return this._calcChunkedData();
        });
        if (isError(data)) {
            return Promise.reject(data);
        }

        const sortedKeys = keys(data).sort();
        return this._returnResultsFromKeys(data, sortedKeys, reverseOrSortOrder, limit, offset);
    }

    getOnly(key: KeyType, reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number)
        : Promise<ItemType[]> {
        return this.getRange(key, key, false, false, reverseOrSortOrder, limit, offset);
    }

    getRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean,
        reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number): Promise<ItemType[]> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }

        let data: Dictionary<ItemType[]> | Dictionary<ItemType>;
        let sortedKeys: string[];
        const err = attempt(() => {
            data = this._calcChunkedData();
            sortedKeys = this._getKeysForRange(data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive).sort();
        });
        if (err) {
            return Promise.reject(err);
        }

        return this._returnResultsFromKeys(data!!!, sortedKeys!!!, reverseOrSortOrder, limit, offset);
    }

    // Warning: This function can throw, make sure to trap.
    private _getKeysForRange(data: Dictionary<ItemType[]> | Dictionary<ItemType>, keyLowRange: KeyType, keyHighRange: KeyType,
        lowRangeExclusive?: boolean, highRangeExclusive?: boolean): string[] {
        const keyLow = serializeKeyToString(keyLowRange, this._keyPath);
        const keyHigh = serializeKeyToString(keyHighRange, this._keyPath);
        return filter(keys(data), key =>
            (key > keyLow || (key === keyLow && !lowRangeExclusive)) && (key < keyHigh || (key === keyHigh && !highRangeExclusive)));
    }

    private _returnResultsFromKeys(data: Dictionary<ItemType[]> | Dictionary<ItemType>, sortedKeys: string[],
        reverseOrSortOrder?: boolean | QuerySortOrder, limit?: number, offset?: number) {
        if (reverseOrSortOrder === true || reverseOrSortOrder === QuerySortOrder.Reverse) {
            sortedKeys = reverse(sortedKeys);
        }

        if (offset) {
            sortedKeys = sortedKeys.slice(offset);
        }

        if (limit) {
            sortedKeys = sortedKeys.slice(0, limit);
        }

        let results = map(sortedKeys, key => data[key]);
        return Promise.resolve(flatten(results));
    }

    countAll(): Promise<number> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }
        const data = attempt(() => {
            return this._calcChunkedData();
        });
        if (isError(data)) {
            return Promise.reject(data);
        }
        return Promise.resolve(keys(data).length);
    }

    countOnly(key: KeyType): Promise<number> {
        return this.countRange(key, key, false, false);
    }

    countRange(keyLowRange: KeyType, keyHighRange: KeyType, lowRangeExclusive?: boolean, highRangeExclusive?: boolean)
        : Promise<number> {
        if (!this._trans.internal_isOpen()) {
            return Promise.reject('InMemoryTransaction already closed');
        }

        const keys = attempt(() => {
            const data = this._calcChunkedData();
            return this._getKeysForRange(data, keyLowRange, keyHighRange, lowRangeExclusive, highRangeExclusive);
        });
        if (isError(keys)) {
            return Promise.reject(keys);
        }

        return Promise.resolve(keys.length);
    }
}
