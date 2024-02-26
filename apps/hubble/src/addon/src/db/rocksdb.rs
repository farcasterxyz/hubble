use crate::store::{self, get_db, hub_error_to_js_throw, increment_vec_u8, HubError, PageOptions};
use neon::context::{Context, FunctionContext};
use neon::handle::Handle;
use neon::object::Object;
use neon::result::JsResult;
use neon::types::buffer::TypedArray;
use neon::types::{
    Finalize, JsArray, JsBoolean, JsBox, JsBuffer, JsFunction, JsNumber, JsObject, JsPromise,
    JsString,
};
use rocksdb::{Options, TransactionDB};
use std::path::Path;
use std::sync::{Arc, RwLock, RwLockReadGuard};

pub struct RocksDbTransactionBatch {
    pub batch: Vec<(Vec<u8>, Option<Vec<u8>>)>,
}

impl RocksDbTransactionBatch {
    pub fn new() -> RocksDbTransactionBatch {
        RocksDbTransactionBatch { batch: Vec::new() }
    }

    pub fn put(&mut self, key: Vec<u8>, value: Vec<u8>) {
        self.batch.push((key, Some(value)));
    }

    pub fn delete(&mut self, key: Vec<u8>) {
        self.batch.push((key, None));
    }
}

pub struct IteratorOptions {
    pub opts: rocksdb::ReadOptions,
    pub reverse: bool,
}

pub struct JsIteratorOptions {
    pub reverse: bool,
    pub gte: Option<Vec<u8>>,
    pub gt: Option<Vec<u8>>,
    pub lt: Vec<u8>,
}

pub struct RocksDB {
    pub db: RwLock<Option<rocksdb::TransactionDB>>,
    pub path: String,
}

impl Finalize for RocksDB {}

impl RocksDB {
    pub fn new(path: &str) -> Result<RocksDB, HubError> {
        // Create RocksDB options
        let mut opts = Options::default();
        opts.create_if_missing(true); // Creates a database if it does not exist

        let mut tx_db_opts = rocksdb::TransactionDBOptions::default();
        tx_db_opts.set_default_lock_timeout(5000); // 5 seconds

        // Open the database with multi-threaded support
        let db = rocksdb::TransactionDB::open(&opts, &tx_db_opts, path).unwrap();
        Ok(RocksDB {
            db: RwLock::new(Some(db)),
            path: path.to_string(),
        })
    }

    pub fn location(&self) -> String {
        self.db()
            .as_ref()
            .unwrap()
            .path()
            .to_str()
            .unwrap()
            .to_string()
    }

    pub fn close(&self) -> Result<(), HubError> {
        let mut db_lock = self.db.write().unwrap();
        if db_lock.is_some() {
            let db = db_lock.take().unwrap();
            drop(db);
        }

        Ok(())
    }

    pub fn destroy(&self) -> Result<(), HubError> {
        self.close()?;
        let path = Path::new(&self.path);

        rocksdb::DB::destroy(&rocksdb::Options::default(), path).map_err(|e| HubError {
            code: "db.internal_error".to_string(),
            message: e.to_string(),
        })
    }

    pub fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, HubError> {
        self.db().as_ref().unwrap().get(key).map_err(|e| HubError {
            code: "db.internal_error".to_string(),
            message: e.to_string(),
        })
    }

    pub fn db(&self) -> RwLockReadGuard<'_, Option<TransactionDB>> {
        self.db.read().unwrap()
    }

    pub fn get_many(&self, keys: &Vec<Vec<u8>>) -> Result<Vec<Vec<u8>>, HubError> {
        let results = self.db().as_ref().unwrap().multi_get(keys);

        // If any of the results are Errors, return an error
        let results = results.into_iter().collect::<Result<Vec<_>, _>>()?;
        let results = results
            .into_iter()
            .map(|r| r.unwrap_or(vec![]))
            .collect::<Vec<_>>();

        Ok(results)
    }

    pub fn put(&self, key: &[u8], value: &[u8]) -> Result<(), HubError> {
        self.db()
            .as_ref()
            .unwrap()
            .put(key, value)
            .map_err(|e| HubError {
                code: "db.internal_error".to_string(),
                message: e.to_string(),
            })
    }

    pub fn del(&self, key: &[u8]) -> Result<(), HubError> {
        self.db()
            .as_ref()
            .unwrap()
            .delete(key)
            .map_err(|e| HubError {
                code: "db.internal_error".to_string(),
                message: e.to_string(),
            })
    }

    pub fn txn(&self) -> RocksDbTransactionBatch {
        RocksDbTransactionBatch::new()
    }

    pub fn commit(&self, batch: RocksDbTransactionBatch) -> Result<(), HubError> {
        let db = self.db();
        let txn = db.as_ref().unwrap().transaction();

        for (key, value) in batch.batch {
            if value.is_none() {
                // println!("rust txn is delete, key: {:?}", key);
                txn.delete(key)?;
            } else {
                // println!("rust txn is put, key: {:?}", key);
                txn.put(key, value.unwrap())?;
            }
        }

        txn.commit().map_err(|e| HubError {
            code: "db.internal_error".to_string(),
            message: e.to_string(),
        })
    }

    fn get_iterator_options(prefix: &[u8], page_options: &PageOptions) -> IteratorOptions {
        // Handle the special case if the prefix is empty, then we want to iterate over the entire database
        if prefix.is_empty() {
            let mut opts = rocksdb::ReadOptions::default();
            opts.set_iterate_lower_bound(vec![]);
            opts.set_iterate_upper_bound(vec![255]);
            return IteratorOptions {
                opts,
                reverse: page_options.reverse,
            };
        }

        let mut lower_prefix;
        let mut upper_prefix;

        if page_options.reverse {
            lower_prefix = prefix.to_vec();
            if let Some(token) = &page_options.page_token {
                upper_prefix = prefix.to_vec();
                upper_prefix.extend_from_slice(token);
            } else {
                upper_prefix = increment_vec_u8(&prefix.to_vec());
            }
        } else {
            if let Some(token) = &page_options.page_token {
                lower_prefix = prefix.to_vec();
                lower_prefix.extend_from_slice(token);

                // move to the next key, since the page_token is the key of the last seen item
                lower_prefix = increment_vec_u8(&lower_prefix);
            } else {
                lower_prefix = prefix.to_vec();
            }

            let prefix_end = increment_vec_u8(&prefix.to_vec());
            upper_prefix = prefix_end.to_vec();
        }

        // println!("lower_prefix: {:?}", lower_prefix);
        // println!("upper_prefix: {:?}", upper_prefix);

        let mut opts = rocksdb::ReadOptions::default();
        opts.set_iterate_lower_bound(lower_prefix);
        opts.set_iterate_upper_bound(upper_prefix);

        IteratorOptions {
            opts,
            reverse: page_options.reverse,
        }
    }

    pub fn for_each_iterator_by_prefix<F>(
        &self,
        prefix: &[u8],
        page_options: &PageOptions,
        mut f: F,
    ) -> Result<(), HubError>
    where
        F: FnMut(&[u8], &[u8]) -> Result<bool, HubError>,
    {
        let iter_opts = RocksDB::get_iterator_options(prefix, page_options);

        let db = self.db();
        let mut iter = db.as_ref().unwrap().raw_iterator_opt(iter_opts.opts);

        if iter_opts.reverse {
            iter.seek_to_last();
        } else {
            iter.seek_to_first();
        }

        while iter.valid() {
            if let Some((key, value)) = iter.item() {
                if !f(&key, &value)? {
                    break;
                }
            }

            if iter_opts.reverse {
                iter.prev();
            } else {
                iter.next();
            }
        }

        Ok(())
    }

    pub fn for_each_iterator_by_jsopts(
        &self,
        js_opts: JsIteratorOptions,
        mut f: impl FnMut(&[u8], &[u8]) -> Result<bool, HubError>,
    ) -> Result<(), HubError> {
        // Can't have both gte and gt set
        if js_opts.gte.is_some() && js_opts.gt.is_some() {
            return Err(HubError {
                code: "db.invalid_iterator_options".to_string(),
                message: "gte and gt cannot be set at the same time".to_string(),
            });
        }

        // At least one of gte or gt must be set
        if js_opts.gte.is_none() && js_opts.gt.is_none() {
            return Err(HubError {
                code: "db.invalid_iterator_options".to_string(),
                message: "gte or gt must be set".to_string(),
            });
        }

        let (lower_bound, increment_first) = if let Some(gte) = js_opts.gte {
            (gte, false)
        } else {
            (js_opts.gt.unwrap(), true)
        };
        let upper_bound = js_opts.lt;
        let reverse = js_opts.reverse;

        let mut opts = rocksdb::ReadOptions::default();
        opts.set_iterate_lower_bound(lower_bound.clone());
        opts.set_iterate_upper_bound(upper_bound);

        let db = self.db();
        let mut iter = db.as_ref().unwrap().raw_iterator_opt(opts);

        if reverse {
            iter.seek_to_last();
        } else {
            iter.seek_to_first();
        }

        // If we are using gt, we need to increment the first key if it matches
        if increment_first
            && iter.valid()
            && iter.key().is_some()
            && iter.key().unwrap() == lower_bound
        {
            iter.next();
        }

        while iter.valid() {
            if let Some((key, value)) = iter.item() {
                if !f(&key, &value)? {
                    break;
                }
            }

            if js_opts.reverse {
                iter.prev();
            } else {
                iter.next();
            }
        }

        Ok(())
    }

    pub fn clear(&self) -> Result<u32, HubError> {
        let mut deleted;

        loop {
            // reset deleted count
            deleted = 0;

            // Iterate over all keys and delete them
            let mut txn = self.txn();
            let db = self.db();

            for item in db.as_ref().unwrap().iterator(rocksdb::IteratorMode::Start) {
                if let Ok((key, _)) = item {
                    txn.delete(key.to_vec());
                    deleted += 1;
                }
            }

            self.commit(txn)?;

            // Check if we deleted anything
            if deleted == 0 {
                break;
            }
        }

        Ok(deleted)
    }

    pub fn approximate_size(&self) -> u64 {
        // TODO: There isn't a good way to get the size of the database
        0
    }
}

// pub fn create_tar_backup(input_dir: &str) -> Result<String, HubError> {
//     let output_file_path = format!(
//         "{}-{}.tar.gz",
//         input_dir,
//         chrono::Local::now().format("%Y-%m-%d-%s")
//     );

//     let start = std::time::SystemTime::now();
//     // info!("Creating tarball for directory: {}", input_dir);

//     let tar_gz = File::create(&output_file_path)?;
//     let enc = GzEncoder::new(tar_gz, Compression::default());
//     let mut tar = Builder::new(enc);

//     tar.append_dir_all(".", input_dir)?;

//     let enc = tar.into_inner()?;
//     enc.finish()?;

//     let metadata = fs::metadata(&output_file_path)?;
//     let time_taken = start.elapsed().expect("Time went backwards");

//     // info!(
//     //     "Tarball created: {} (size: {} bytes, time taken: {:?})",
//     //     output_file_path,
//     //     metadata.len(),
//     //     time_taken
//     // );

//     Ok(output_file_path)
// }

impl RocksDB {
    pub fn js_create_db(mut cx: FunctionContext) -> JsResult<JsBox<Arc<RocksDB>>> {
        // First arg is the full system path as string
        let path = cx.argument::<JsString>(0)?.value(&mut cx);

        let db = RocksDB::new(&path);
        if db.is_err() {
            return hub_error_to_js_throw(&mut cx, db.err().unwrap());
        }

        Ok(cx.boxed(Arc::new(db.unwrap())))
    }

    pub fn js_clear(mut cx: FunctionContext) -> JsResult<JsNumber> {
        let db = get_db(&mut cx)?;
        let result = match db.clear() {
            Ok(result) => result,
            Err(e) => return hub_error_to_js_throw(&mut cx, e),
        };

        Ok(cx.number(result))
    }

    pub fn js_close(mut cx: FunctionContext) -> JsResult<JsBoolean> {
        let db = get_db(&mut cx)?;
        let result = match db.close() {
            Ok(_) => true,
            Err(e) => return hub_error_to_js_throw(&mut cx, e),
        };

        Ok(cx.boolean(result))
    }

    pub fn js_destroy(mut cx: FunctionContext) -> JsResult<JsBoolean> {
        // return cx.throw_error::<String, _>(format!("Not implemented"));

        let db = get_db(&mut cx)?;

        if let Err(e) = db.destroy() {
            return hub_error_to_js_throw(&mut cx, e);
        }

        Ok(cx.boolean(true))
    }

    pub fn js_location(mut cx: FunctionContext) -> JsResult<JsString> {
        let db = get_db(&mut cx)?;

        Ok(cx.string(db.location()))
    }

    pub fn js_put(mut cx: FunctionContext) -> JsResult<JsPromise> {
        let db = get_db(&mut cx)?;

        let key = cx.argument::<JsBuffer>(0)?.as_slice(&cx).to_vec();
        let value = cx.argument::<JsBuffer>(1)?.as_slice(&cx).to_vec();

        match db.put(&key, &value) {
            Ok(_) => (),
            Err(e) => return hub_error_to_js_throw(&mut cx, e),
        };

        let channel = cx.channel();
        let (deferred, promise) = cx.promise();
        deferred.settle_with(&channel, move |mut cx| Ok(cx.undefined()));

        Ok(promise)
    }

    pub fn js_get(mut cx: FunctionContext) -> JsResult<JsBuffer> {
        let db = get_db(&mut cx)?;
        let key = cx.argument::<JsBuffer>(0)?.as_slice(&cx).to_vec();

        let value = match db.get(&key) {
            Ok(Some(value)) => value,
            Ok(None) => {
                return hub_error_to_js_throw(
                    &mut cx,
                    HubError {
                        code: "not_found".to_string(),
                        message: format!("NotFound: key not found: {:?}", key),
                    },
                )
            }
            Err(e) => return hub_error_to_js_throw(&mut cx, e),
        };

        let mut buffer = cx.buffer(value.len())?;
        let target = buffer.as_mut_slice(&mut cx);
        target.copy_from_slice(&value);
        Ok(buffer)
    }

    pub fn js_get_many(mut cx: FunctionContext) -> JsResult<JsPromise> {
        let db = get_db(&mut cx)?;
        let keys = cx.argument::<JsArray>(0)?;
        let mut key_vec = Vec::new();

        for i in 0..keys.len(&mut cx) {
            let key = keys
                .get::<JsBuffer, _, u32>(&mut cx, i)?
                .downcast_or_throw::<JsBuffer, _>(&mut cx)?;
            key_vec.push(key.as_slice(&cx).to_vec());
        }

        let result = match db.get_many(&key_vec) {
            Ok(result) => result,
            Err(e) => return hub_error_to_js_throw(&mut cx, e),
        };

        let channel = cx.channel();
        let (deferred, promise) = cx.promise();
        deferred.settle_with(&channel, move |mut cx| {
            let js_array = JsArray::new(&mut cx, result.len() as u32);
            for (i, value) in result.iter().enumerate() {
                let mut buffer = cx.buffer(value.len())?;
                let target = buffer.as_mut_slice(&mut cx);
                target.copy_from_slice(&value);
                js_array.set(&mut cx, i as u32, buffer)?;
            }

            Ok(js_array)
        });

        Ok(promise)
    }

    pub fn js_del(mut cx: FunctionContext) -> JsResult<JsPromise> {
        let db = get_db(&mut cx)?;
        let key = cx.argument::<JsBuffer>(0)?.as_slice(&cx).to_vec();

        match db.del(&key) {
            Ok(_) => (),
            Err(e) => return hub_error_to_js_throw(&mut cx, e),
        };

        let channel = cx.channel();
        let (deferred, promise) = cx.promise();
        deferred.settle_with(&channel, move |mut cx| Ok(cx.undefined()));

        Ok(promise)
    }

    pub fn js_commit_transaction(mut cx: FunctionContext) -> JsResult<JsPromise> {
        let db = get_db(&mut cx)?;

        // We'll read an array of Objects, each with a key and value
        let batch = cx.argument::<JsArray>(0)?;
        let mut txn_batch = RocksDbTransactionBatch::new();

        for i in 0..batch.len(&mut cx) {
            let js_object = batch
                .get::<JsObject, _, _>(&mut cx, i as u32)?
                .downcast_or_throw::<JsObject, _>(&mut cx)?;

            let key = js_object
                .get::<JsBuffer, _, _>(&mut cx, "key")?
                .downcast_or_throw::<JsBuffer, _>(&mut cx)?
                .as_slice(&cx)
                .to_vec();
            let value = match js_object.get_opt::<JsBuffer, _, _>(&mut cx, "value")? {
                Some(value) => {
                    let value = value
                        .downcast_or_throw::<JsBuffer, _>(&mut cx)?
                        .as_slice(&cx)
                        .to_vec();
                    if value.is_empty() {
                        None
                    } else {
                        Some(value)
                    }
                }
                None => None,
            };

            if value.is_none() {
                txn_batch.delete(key);
            } else {
                txn_batch.put(key, value.unwrap());
            }
        }

        match db.commit(txn_batch) {
            Ok(_) => (),
            Err(e) => return hub_error_to_js_throw(&mut cx, e),
        };

        let channel = cx.channel();
        let (deferred, promise) = cx.promise();
        deferred.settle_with(&channel, move |mut cx| Ok(cx.undefined()));

        Ok(promise)
    }

    // Define a new function that encapsulates the callback logic.
    fn call_js_callback<'a>(
        cx: &mut FunctionContext<'a>,
        callback: &Handle<JsFunction>,
        key: &[u8],
        value: &[u8],
    ) -> Result<bool, HubError> {
        let undefined = cx.undefined(); // pass as "this" to the JS function
        let mut callback_args = Vec::new();

        // Prepare the key buffer
        callback_args.push(cx.buffer(key.len())?);
        let key_buffer = callback_args[0].as_mut_slice(cx);
        key_buffer.copy_from_slice(key);

        // Prepare the value buffer
        callback_args.push(cx.buffer(value.len())?);
        let value_buffer = callback_args[1].as_mut_slice(cx);
        value_buffer.copy_from_slice(value);

        // Convert callback arguments to a format suitable for calling the JS function
        let callback_args = callback_args
            .into_iter()
            .map(|arg| arg.upcast())
            .collect::<Vec<_>>();

        // Call the JS callback function
        let result = callback
            .call(cx, undefined, callback_args)?
            .downcast_or_throw::<JsBoolean, _>(cx)?
            .value(cx);

        // Return true if we want to continue, false if we want to abort (inverted logic from JS callback)
        Ok(!result)
    }

    pub fn js_for_each_iterator_by_prefix(mut cx: FunctionContext) -> JsResult<JsPromise> {
        let db = get_db(&mut cx)?;

        // Prefix
        let prefix = cx.argument::<JsBuffer>(0)?.as_slice(&cx).to_vec();

        // Page options
        let page_options = store::get_page_options(&mut cx, 1)?;

        // The argument is a callback function
        let callback = cx.argument::<JsFunction>(2)?;

        let result = db.for_each_iterator_by_prefix(&prefix, &page_options, |key, value| {
            // Use the extracted function here
            Self::call_js_callback(&mut cx, &callback, key, value)
        });

        if result.is_err() {
            return hub_error_to_js_throw(&mut cx, result.err().unwrap());
        }

        let channel = cx.channel();
        let (deferred, promise) = cx.promise();
        deferred.settle_with(&channel, move |mut cx| Ok(cx.undefined()));

        Ok(promise)
    }

    pub fn js_for_each_iterator_by_js_opts(mut cx: FunctionContext) -> JsResult<JsPromise> {
        let db = get_db(&mut cx)?;

        // Page options
        let js_opts = cx.argument::<JsObject>(0)?;
        let reverse = js_opts
            .get_opt::<JsBoolean, _, _>(&mut cx, "reverse")?
            .map_or(false, |js_boolean| js_boolean.value(&mut cx));
        let gte = match js_opts.get_opt::<JsBuffer, _, _>(&mut cx, "gte")? {
            Some(buffer) => Some(buffer.as_slice(&cx).to_vec()),
            None => None,
        };
        let gt = match js_opts.get_opt::<JsBuffer, _, _>(&mut cx, "gt")? {
            Some(buffer) => Some(buffer.as_slice(&cx).to_vec()),
            None => None,
        };
        let lt = js_opts
            .get::<JsBuffer, _, _>(&mut cx, "lt")?
            .as_slice(&cx)
            .to_vec();

        let js_opts = JsIteratorOptions {
            reverse,
            gte,
            gt,
            lt,
        };

        // The argument is a callback function
        let callback = cx.argument::<JsFunction>(1)?;

        let result = db.for_each_iterator_by_jsopts(js_opts, |key, value| {
            // Use the extracted function here
            Self::call_js_callback(&mut cx, &callback, key, value)
        });

        if result.is_err() {
            return hub_error_to_js_throw(&mut cx, result.err().unwrap());
        }

        let channel = cx.channel();
        let (deferred, promise) = cx.promise();
        deferred.settle_with(&channel, move |mut cx| Ok(cx.undefined()));

        Ok(promise)
    }
}
