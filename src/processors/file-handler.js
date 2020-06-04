// Copyright (c) 2020 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

import {FileReader} from 'global/window';
import Console from 'global/console';
import {parse, parseInBatches, registerLoaders} from '@loaders.gl/core';
import {JSONLoader} from '@loaders.gl/json';
import {CSVLoader} from '@loaders.gl/csv';
import {
  processCsvData,
  processGeojson,
  processKeplerglJSON,
  processRowObject
} from './data-processor';
import {isPlainObject, generateHashId} from 'utils/utils';
import {DATASET_FORMATS} from 'constants/default-settings';

registerLoaders([JSONLoader, CSVLoader]);

export async function readFile({file, fileCache = []}) {
  const result = await loadFile(file);
  if (!result || !result.data) {
    Console.warn(`Cannot parse file ${file.name}.`);
    // return fileCache, to keep process other files
    return fileCache;
  }
  return [
    ...fileCache,
    {
      data: result.data,
      info: {
        label: file.name,
        format: result.format
      }
    }
  ];
}

function isCsvRows(content) {
  return Array.isArray(content) && content.length && Array.isArray(content[0]);
}

const SIZE_THRESHOLD =  30 * 1024 * 1024;
export async function loadFile(file) {
  // Don't read as string files with a size 250MB or bigger because it may
  // exceed the browsers maximum string length.
  console.time('loadFile');
  const content =
    file.size >= SIZE_THRESHOLD ? await parseFileInBatches(file) : await parseFile(file);

  console.timeEnd('loadFile');
  console.log(content);
  let format;
  let processor;
  if (isCsvRows(content)) {
    format = DATASET_FORMATS.csv;
    processor = processCsvData;
  } else if (isKeplerGlMap(content)) {
    (format = DATASET_FORMATS.keplergl), (processor = processKeplerglJSON);
  } else if (isRowObject(content)) {
    format = DATASET_FORMATS.row;
    processor = processRowObject;
  } else if (isGeoJson(content)) {
    format = DATASET_FORMATS.geojson;
    processor = processGeojson;
  }

  if (format && processor) {
    console.time('process file content')
    const data = processor(content);
    console.timeEnd('process file content')
    return {format, data};
  }
  return null;
}

async function* fileReaderAsyncIterable(file, chunkSize) {
  let offset = 0;
  while (offset < file.size) {
    const end = offset + chunkSize;
    const slice = file.slice(offset, end);
    const chunk = await new Promise((resolve, reject) => {
      const fileReader = new FileReader(file);
      fileReader.onload = event => {
        resolve(event.target.result);
      };
      fileReader.onerror = reject;
      fileReader.onabort = reject;
      fileReader.readAsArrayBuffer(slice);
    });
    offset = end;
    yield chunk;
  }
}
const CSV_LOADER_OPTION = {header: false, batchSize: 4000};
const JSON_LOADER_OPTION = {_rootObjectBatches: true};
// 10 mb
const chunkSize = 10 * 1024 * 1024;

async function parseFileInBatches(file) {
  console.log('parseFileInBatches');

  const batchIterator = await parseInBatches(
    fileReaderAsyncIterable(file, chunkSize),
    {
      csv: CSV_LOADER_OPTION,
      json: JSON_LOADER_OPTION
    },
    file.name
  );
  let result = {};
  let batches = [];
  let bidx = 0;

  for await (const batch of batchIterator) {
    console.log(bidx);
    // Last batch will have this special type and will provide all the root
    // properties of the parsed document.
    if (batch.batchType === 'root-object-batch-complete') {
      // TODO: It would be nice if loaders.gl could handle this detail when
      // parsing in batches, otherwise we can't entirely delegate the
      // responsibility of parsing any format.
      if (batch.container.features) {
        result.features = batches;
      } else if (batch.container.datasets) {
        result.datasets = batches;
      } else {
        // HACK to get things moving, I couldn't find any realiable way to
        // identify a Row JSON—batch.container seems to equal batches[0] though.
        result = batches;
      }
      // We copy all properties but skip datasets or fatures becuase they are
      // empty arrays—we got its content in previous batches.
      for (const k in batch.container) {
        if (k !== 'datasets' && k !== 'features') {
          result[k] = batch.container[k];
        }
      }
    } else {
      for (let i = 0; i < batch.data.length; i++) {
        batches.push(batch.data[i]);
        // batches = batches.concat(batch.data);
      }
    }
    bidx++;
  }
  return Object.keys(result).length === 0 // csv doesn't have any keys
    ? batches
    : result;
}

function parseFile(file) {
  console.log('parseFile');

  return new Promise((resolve, reject) => {
    const fileReader = new FileReader(file);
    fileReader.onload = async ({target: {result}}) => {
      try {
        const data = await parse(
          result,
          {
            csv: {header: false}
          },
          file.name
        );
        resolve(data);
      } catch (e) {
        reject(e);
      }
    };
    fileReader.onerror = reject;
    fileReader.onabort = reject;
    fileReader.readAsText(file, 'UTF-8');
  });
}

export function isGeoJson(json) {
  // json can be feature collection
  // or simgle feature
  return isPlainObject(json) && (isFeature(json) || isFeatureCollection(json));
}

export function isFeature(json) {
  return json.type === 'Feature' && json.geometry;
}

export function isFeatureCollection(json) {
  return json.type === 'FeatureCollection' && json.features;
}

export function isRowObject(json) {
  return Array.isArray(json) && isPlainObject(json[0]);
}

export function isKeplerGlMap(json) {
  return (
    isPlainObject(json) &&
    json.datasets &&
    json.config &&
    json.info &&
    json.info.app === 'kepler.gl'
  );
}

export function determineJsonProcess({dataset, format}, defaultProcessor) {
  if (isKeplerGlMap(dataset)) {
    return processKeplerglJSON;
  }

  return defaultProcessor;
}

export function filesToDataPayload(fileCache) {
  // seperate out files which could be a single datasets. or a keplergl map json
  const collection = fileCache.reduce(
    (accu, file) => {
      const {data, info = {}} = file;
      const {format} = info;
      if (format === DATASET_FORMATS.keplergl) {
        // if file contains a single kepler map dataset & config
        accu.keplerMaps.push({
          ...data,
          options: {
            centerMap: !(data.config && data.config.mapState)
          }
        });
      } else if (DATASET_FORMATS[format]) {
        // if file contains only data
        const newDataset = {
          data,
          info: {
            id: info.id || generateHashId(4),
            ...info
          }
        };
        accu.datasets.push(newDataset);
      }
      return accu;
    },
    {datasets: [], keplerMaps: []}
  );

  // add kepler map first with config
  // add datasets later in one add data call
  return collection.keplerMaps.concat({datasets: collection.datasets});
}
