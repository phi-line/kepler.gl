// Copyright (c) 2022 Uber Technologies, Inc.
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

import {csvParseRows, csvFormatRows} from 'd3-dsv';
import {range} from 'd3-array';
import {console as globalConsole} from 'global/window';
import assert from 'assert';
import {Analyzer, DATA_TYPES as AnalyzerDATA_TYPES} from 'type-analyzer';
import normalize from '@mapbox/geojson-normalize';
import {ALL_FIELD_TYPES, DATASET_FORMATS, GUIDES_FILE_FORMAT_DOC} from '@kepler.gl/constants';
import {notNullorUndefined, parseFieldValue} from 'utils/data-utils';
import {KeplerGlSchema, SavedMap, ParsedDataset, LoadedMap} from 'schemas';
import {hasOwnProperty, isPlainObject, toArray} from 'utils/utils';
import {Field} from 'utils/table-utils/kepler-table';
import {DataContainerInterface} from 'utils/table-utils/data-container-interface';
import {ProcessorResult, RowData} from './types';
import {Feature} from '@nebula.gl/edit-modes';

export const ACCEPTED_ANALYZER_TYPES = [
  AnalyzerDATA_TYPES.DATE,
  AnalyzerDATA_TYPES.TIME,
  AnalyzerDATA_TYPES.DATETIME,
  AnalyzerDATA_TYPES.NUMBER,
  AnalyzerDATA_TYPES.INT,
  AnalyzerDATA_TYPES.FLOAT,
  AnalyzerDATA_TYPES.BOOLEAN,
  AnalyzerDATA_TYPES.STRING,
  AnalyzerDATA_TYPES.GEOMETRY,
  AnalyzerDATA_TYPES.GEOMETRY_FROM_STRING,
  AnalyzerDATA_TYPES.PAIR_GEOMETRY_FROM_STRING,
  AnalyzerDATA_TYPES.ZIPCODE,
  AnalyzerDATA_TYPES.ARRAY,
  AnalyzerDATA_TYPES.OBJECT
];

// if any of these value occurs in csv, parse it to null;
// const CSV_NULLS = ['', 'null', 'NULL', 'Null', 'NaN', '/N'];
// matches empty string
export const CSV_NULLS = /^(null|NULL|Null|NaN|\/N||)$/;

const IGNORE_DATA_TYPES = Object.keys(AnalyzerDATA_TYPES).filter(
  type => !ACCEPTED_ANALYZER_TYPES.includes(type)
);

export const PARSE_FIELD_VALUE_FROM_STRING = {
  [ALL_FIELD_TYPES.boolean]: {
    valid: (d: unknown): boolean => typeof d === 'boolean',
    parse: (d: unknown): boolean => d === 'true' || d === 'True' || d === 'TRUE' || d === '1'
  },
  [ALL_FIELD_TYPES.integer]: {
    // @ts-ignore
    valid: (d: unknown): boolean => parseInt(d, 10) === d,
    // @ts-ignore
    parse: (d: unknown): number => parseInt(d, 10)
  },
  [ALL_FIELD_TYPES.timestamp]: {
    valid: (d: unknown, field: Field): boolean =>
      ['x', 'X'].includes(field.format) ? typeof d === 'number' : typeof d === 'string',
    parse: (d: any, field: Field) => (['x', 'X'].includes(field.format) ? Number(d) : d)
  },
  [ALL_FIELD_TYPES.real]: {
    // @ts-ignore
    valid: (d: unknown): boolean => parseFloat(d) === d,
    // Note this will result in NaN for some string
    parse: parseFloat
  }
};

/**
 * Process csv data, output a data object with `{fields: [], rows: []}`.
 * The data object can be wrapped in a `dataset` and pass to [`addDataToMap`](../actions/actions.md#adddatatomap)
 * @param rawData raw csv string
 * @returns data object `{fields: [], rows: []}` can be passed to addDataToMaps
 * @public
 * @example
 * import {processCsvData} from 'kepler.gl/processors';
 *
 * const testData = `gps_data.utc_timestamp,gps_data.lat,gps_data.lng,gps_data.types,epoch,has_result,id,time,begintrip_ts_utc,begintrip_ts_local,date
 * 2016-09-17 00:09:55,29.9900937,31.2590542,driver_analytics,1472688000000,False,1,2016-09-23T00:00:00.000Z,2016-10-01 09:41:39+00:00,2016-10-01 09:41:39+00:00,2016-09-23
 * 2016-09-17 00:10:56,29.9927699,31.2461142,driver_analytics,1472688000000,False,2,2016-09-23T00:00:00.000Z,2016-10-01 09:46:37+00:00,2016-10-01 16:46:37+00:00,2016-09-23
 * 2016-09-17 00:11:56,29.9907261,31.2312742,driver_analytics,1472688000000,False,3,2016-09-23T00:00:00.000Z,,,2016-09-23
 * 2016-09-17 00:12:58,29.9870074,31.2175827,driver_analytics,1472688000000,False,4,2016-09-23T00:00:00.000Z,,,2016-09-23`
 *
 * const dataset = {
 *  info: {id: 'test_data', label: 'My Csv'},
 *  data: processCsvData(testData)
 * };
 *
 * dispatch(addDataToMap({
 *  datasets: [dataset],
 *  options: {centerMap: true, readOnly: true}
 * }));
 */
export function processCsvData(rawData: unknown[][], header?: string[]): ProcessorResult {
  let rows: unknown[][] | undefined;
  let headerRow: string[] | undefined;

  if (typeof rawData === 'string') {
    const parsedRows: string[][] = csvParseRows(rawData);

    if (!Array.isArray(parsedRows) || parsedRows.length < 2) {
      // looks like an empty file, throw error to be catch
      throw new Error('process Csv Data Failed: CSV is empty');
    }
    headerRow = parsedRows[0];
    rows = parsedRows.slice(1);
  } else if (Array.isArray(rawData) && rawData.length) {
    rows = rawData;
    headerRow = header;

    if (!Array.isArray(headerRow)) {
      // if data is passed in as array of rows and missing header
      // assume first row is header
      // @ts-ignore
      headerRow = rawData[0];
      rows = rawData.slice(1);
    }
  }

  if (!rows || !headerRow) {
    throw new Error('invalid input passed to processCsvData');
  }

  // here we assume the csv file that people uploaded will have first row
  // as name of the column

  cleanUpFalsyCsvValue(rows);
  // No need to run type detection on every data point
  // here we get a list of none null values to run analyze on
  const sample = getSampleForTypeAnalyze({fields: headerRow, rows});
  const fields = getFieldsFromData(sample, headerRow);
  const parsedRows = parseRowsByFields(rows, fields);

  return {fields, rows: parsedRows};
}

/**
 * Parse rows of csv by analyzed field types. So that `'1'` -> `1`, `'True'` -> `true`
 * @param rows
 * @param fields
 */
export function parseRowsByFields(rows: any[][], fields: Field[]) {
  // Edit rows in place
  const geojsonFieldIdx = fields.findIndex(f => f.name === '_geojson');
  fields.forEach(parseCsvRowsByFieldType.bind(null, rows, geojsonFieldIdx));

  return rows;
}
/**
 * Getting sample data for analyzing field type.
 */
export function getSampleForTypeAnalyze({
  fields,
  rows,
  sampleCount = 50
}: {
  fields: string[];
  rows: unknown[][];
  sampleCount?: number;
}): RowData {
  const total = Math.min(sampleCount, rows.length);
  // const fieldOrder = fields.map(f => f.name);
  const sample = range(0, total, 1).map(d => ({}));

  // collect sample data for each field
  fields.forEach((field, fieldIdx) => {
    // data counter
    let i = 0;
    // sample counter
    let j = 0;

    while (j < total) {
      if (i >= rows.length) {
        // if depleted data pool
        sample[j][field] = null;
        j++;
      } else if (notNullorUndefined(rows[i][fieldIdx])) {
        const value = rows[i][fieldIdx];
        sample[j][field] = typeof value === 'string' ? value.trim() : value;
        j++;
        i++;
      } else {
        i++;
      }
    }
  });

  return sample;
}

/**
 * Convert falsy value in csv including `'', 'null', 'NULL', 'Null', 'NaN'` to `null`,
 * so that type-analyzer won't detect it as string
 *
 * @param rows
 */
function cleanUpFalsyCsvValue(rows: unknown[][]): void {
  const re = new RegExp(CSV_NULLS, 'g');
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < rows[i].length; j++) {
      // analyzer will set any fields to 'string' if there are empty values
      // which will be parsed as '' by d3.csv
      // here we parse empty data as null
      // TODO: create warning when deltect `CSV_NULLS` in the data
      if (typeof rows[i][j] === 'string' && (rows[i][j] as string).match(re)) {
        rows[i][j] = null;
      }
    }
  }
}

/**
 * Process uploaded csv file to parse value by field type
 *
 * @param rows
 * @param geoFieldIdx field index
 * @param field
 * @param i
 */
export function parseCsvRowsByFieldType(
  rows: unknown[][],
  geoFieldIdx: number,
  field: Field,
  i: number
): void {
  const parser = PARSE_FIELD_VALUE_FROM_STRING[field.type];
  if (parser) {
    // check first not null value of it's already parsed
    const first = rows.find(r => notNullorUndefined(r[i]));
    if (!first || parser.valid(first[i], field)) {
      return;
    }
    rows.forEach(row => {
      // parse string value based on field type
      if (row[i] !== null) {
        row[i] = parser.parse(row[i], field);
        if (
          geoFieldIdx > -1 &&
          isPlainObject(row[geoFieldIdx]) &&
          // @ts-ignore
          hasOwnProperty(row[geoFieldIdx], 'properties')
        ) {
          // @ts-ignore
          row[geoFieldIdx].properties[field.name] = row[i];
        }
      }
    });
  }
}

/**
 * Analyze field types from data in `string` format, e.g. uploaded csv.
 * Assign `type`, `fieldIdx` and `format` (timestamp only) to each field
 *
 * @param data array of row object
 * @param fieldOrder array of field names as string
 * @returns formatted fields
 * @public
 * @example
 *
 * import {getFieldsFromData} from 'kepler.gl/processors';
 * const data = [{
 *   time: '2016-09-17 00:09:55',
 *   value: '4',
 *   surge: '1.2',
 *   isTrip: 'true',
 *   zeroOnes: '0'
 * }, {
 *   time: '2016-09-17 00:30:08',
 *   value: '3',
 *   surge: null,
 *   isTrip: 'false',
 *   zeroOnes: '1'
 * }, {
 *   time: null,
 *   value: '2',
 *   surge: '1.3',
 *   isTrip: null,
 *   zeroOnes: '1'
 * }];
 *
 * const fieldOrder = ['time', 'value', 'surge', 'isTrip', 'zeroOnes'];
 * const fields = getFieldsFromData(data, fieldOrder);
 * // fields = [
 * // {name: 'time', format: 'YYYY-M-D H:m:s', fieldIdx: 1, type: 'timestamp'},
 * // {name: 'value', format: '', fieldIdx: 4, type: 'integer'},
 * // {name: 'surge', format: '', fieldIdx: 5, type: 'real'},
 * // {name: 'isTrip', format: '', fieldIdx: 6, type: 'boolean'},
 * // {name: 'zeroOnes', format: '', fieldIdx: 7, type: 'integer'}];
 *
 */
export function getFieldsFromData(data: RowData, fieldOrder: string[]): Field[] {
  // add a check for epoch timestamp
  const metadata = Analyzer.computeColMeta(
    data,
    [
      {regex: /.*geojson|all_points/g, dataType: 'GEOMETRY'},
      {regex: /.*census/g, dataType: 'STRING'}
    ],
    {ignoredDataTypes: IGNORE_DATA_TYPES}
  );

  const {fieldByIndex} = renameDuplicateFields(fieldOrder);

  const result = fieldOrder.map((field, index) => {
    const name = fieldByIndex[index];

    const fieldMeta = metadata.find(m => m.key === field);
    const {type, format} = fieldMeta || {};

    return {
      name,
      id: name,
      displayName: name,
      format,
      fieldIdx: index,
      type: analyzerTypeToFieldType(type),
      analyzerType: type,
      valueAccessor: dc => d => {
        return dc.valueAt(d.index, index);
      }
    };
  });

  return result;
}

/**
 * pass in an array of field names, rename duplicated one
 * and return a map from old field index to new name
 *
 * @param fieldOrder
 * @returns new field name by index
 */
export function renameDuplicateFields(
  fieldOrder: string[]
): {allNames: string[]; fieldByIndex: string[]} {
  return fieldOrder.reduce<{allNames: string[]; fieldByIndex: string[]}>(
    (accu, field, i) => {
      const {allNames} = accu;
      let fieldName = field;

      // add a counter to duplicated names
      if (allNames.includes(field)) {
        let counter = 0;
        while (allNames.includes(`${field}-${counter}`)) {
          counter++;
        }
        fieldName = `${field}-${counter}`;
      }

      accu.fieldByIndex[i] = fieldName;
      accu.allNames.push(fieldName);

      return accu;
    },
    {allNames: [], fieldByIndex: []}
  );
}

/**
 * Convert type-analyzer output to kepler.gl field types
 *
 * @param aType
 * @returns corresponding type in `ALL_FIELD_TYPES`
 */
/* eslint-disable complexity */
export function analyzerTypeToFieldType(aType: string): string {
  const {
    DATE,
    TIME,
    DATETIME,
    NUMBER,
    INT,
    FLOAT,
    BOOLEAN,
    STRING,
    GEOMETRY,
    GEOMETRY_FROM_STRING,
    PAIR_GEOMETRY_FROM_STRING,
    ZIPCODE,
    ARRAY,
    OBJECT
  } = AnalyzerDATA_TYPES;

  // TODO: un recognized types
  // CURRENCY PERCENT NONE
  switch (aType) {
    case DATE:
      return ALL_FIELD_TYPES.date;
    case TIME:
    case DATETIME:
      return ALL_FIELD_TYPES.timestamp;
    case FLOAT:
      return ALL_FIELD_TYPES.real;
    case INT:
      return ALL_FIELD_TYPES.integer;
    case BOOLEAN:
      return ALL_FIELD_TYPES.boolean;
    case GEOMETRY:
    case GEOMETRY_FROM_STRING:
    case PAIR_GEOMETRY_FROM_STRING:
    case ARRAY:
    case OBJECT:
      // TODO: create a new data type for objects and arrays
      return ALL_FIELD_TYPES.geojson;
    case NUMBER:
    case STRING:
    case ZIPCODE:
      return ALL_FIELD_TYPES.string;
    default:
      globalConsole.warn(`Unsupported analyzer type: ${aType}`);
      return ALL_FIELD_TYPES.string;
  }
}
/* eslint-enable complexity */

/**
 * Process data where each row is an object, output can be passed to [`addDataToMap`](../actions/actions.md#adddatatomap)
 * NOTE: This function may mutate input.
 * @param rawData an array of row object, each object should have the same number of keys
 * @returns dataset containing `fields` and `rows`
 * @public
 * @example
 * import {addDataToMap} from 'kepler.gl/actions';
 * import {processRowObject} from 'kepler.gl/processors';
 *
 * const data = [
 *  {lat: 31.27, lng: 127.56, value: 3},
 *  {lat: 31.22, lng: 126.26, value: 1}
 * ];
 *
 * dispatch(addDataToMap({
 *  datasets: {
 *    info: {label: 'My Data', id: 'my_data'},
 *    data: processRowObject(data)
 *  }
 * }));
 */
export function processRowObject(rawData: unknown[]): ProcessorResult {
  if (!Array.isArray(rawData)) {
    return null;
  } else if (!rawData.length) {
    // data is empty
    return {
      fields: [],
      rows: []
    };
  }

  const keys = Object.keys(rawData[0]); // [lat, lng, value]
  const rows = rawData.map(d => keys.map(key => d[key])); // [[31.27, 127.56, 3]]

  // row object an still contain values like `Null` or `N/A`
  cleanUpFalsyCsvValue(rows);

  return processCsvData(rows, keys);
}

/**
 * Process GeoJSON [`FeatureCollection`](http://wiki.geojson.org/GeoJSON_draft_version_6#FeatureCollection),
 * output a data object with `{fields: [], rows: []}`.
 * The data object can be wrapped in a `dataset` and passed to [`addDataToMap`](../actions/actions.md#adddatatomap)
 * NOTE: This function may mutate input.
 *
 * @param rawData raw geojson feature collection
 * @returns dataset containing `fields` and `rows`
 * @public
 * @example
 * import {addDataToMap} from 'kepler.gl/actions';
 * import {processGeojson} from 'kepler.gl/processors';
 *
 * const geojson = {
 * 	"type" : "FeatureCollection",
 * 	"features" : [{
 * 		"type" : "Feature",
 * 		"properties" : {
 * 			"capacity" : "10",
 * 			"type" : "U-Rack"
 * 		},
 * 		"geometry" : {
 * 			"type" : "Point",
 * 			"coordinates" : [ -71.073283, 42.417500 ]
 * 		}
 * 	}]
 * };
 *
 * dispatch(addDataToMap({
 *  datasets: {
 *    info: {
 *      label: 'Sample Taxi Trips in New York City',
 *      id: 'test_trip_data'
 *    },
 *    data: processGeojson(geojson)
 *  }
 * }));
 */
export function processGeojson(rawData: unknown): ProcessorResult {
  const normalizedGeojson = normalize(rawData);

  if (!normalizedGeojson || !Array.isArray(normalizedGeojson.features)) {
    const error = new Error(
      `Read File Failed: File is not a valid GeoJSON. Read more about [supported file format](${GUIDES_FILE_FORMAT_DOC})`
    );
    throw error;
    // fail to normalize geojson
  }

  // getting all feature fields
  const allDataRows: Array<{_geojson: Feature} & keyof Feature> = [];
  for (let i = 0; i < normalizedGeojson.features.length; i++) {
    const f = normalizedGeojson.features[i];
    if (f.geometry) {
      allDataRows.push({
        // add feature to _geojson field
        _geojson: f,
        ...(f.properties || {})
      });
    }
  }
  // get all the field
  const fields = allDataRows.reduce<string[]>((accu, curr) => {
    Object.keys(curr).forEach(key => {
      if (!accu.includes(key)) {
        accu.push(key);
      }
    });
    return accu;
  }, []);

  // make sure each feature has exact same fields
  allDataRows.forEach(d => {
    fields.forEach(f => {
      if (!(f in d)) {
        d[f] = null;
        d._geojson.properties[f] = null;
      }
    });
  });

  return processRowObject(allDataRows);
}

/**
 * On export data to csv
 * @param dataContainer
 * @param fields `dataset.fields`
 * @returns csv string
 */
export function formatCsv(data: DataContainerInterface, fields: Field[]): string {
  const columns = fields.map(f => f.displayName || f.name);
  const formattedData = [columns];

  // parse geojson object as string
  for (const row of data.rows(true)) {
    formattedData.push(row.map((d, i) => parseFieldValue(d, fields[i].type)));
  }

  return csvFormatRows(formattedData);
}

/**
 * Validate input data, adding missing field types, rename duplicate columns
 */
export function validateInputData(data: Record<string, unknown>): ProcessorResult {
  if (!isPlainObject(data)) {
    assert('addDataToMap Error: dataset.data cannot be null');
    return null;
  } else if (!Array.isArray(data.fields)) {
    assert('addDataToMap Error: expect dataset.data.fields to be an array');
    return null;
  } else if (!Array.isArray(data.rows)) {
    assert('addDataToMap Error: expect dataset.data.rows to be an array');
    return null;
  }

  const {fields, rows} = data;

  // check if all fields has name, format and type
  const allValid = fields.every((f, i) => {
    if (!isPlainObject(f)) {
      assert(`fields needs to be an array of object, but find ${typeof f}`);
      fields[i] = {};
    }

    if (!f.name) {
      assert(`field.name is required but missing in ${JSON.stringify(f)}`);
      // assign a name
      fields[i].name = `column_${i}`;
    }

    if (!ALL_FIELD_TYPES[f.type]) {
      assert(`unknown field type ${f.type}`);
      return false;
    }

    if (!fields.every(field => field.analyzerType)) {
      assert('field missing analyzerType');
      return false;
    }

    // check time format is correct based on first 10 not empty element
    if (f.type === ALL_FIELD_TYPES.timestamp) {
      const sample = findNonEmptyRowsAtField(rows, i, 10).map(r => ({ts: r[i]}));
      const analyzedType = Analyzer.computeColMeta(sample)[0];
      return analyzedType && analyzedType.category === 'TIME' && analyzedType.format === f.format;
    }

    return true;
  });

  if (allValid) {
    return {rows, fields};
  }

  // if any field has missing type, recalculate it for everyone
  // because we simply lost faith in humanity
  const sampleData = getSampleForTypeAnalyze({
    fields: fields.map(f => f.name),
    rows
  });
  const fieldOrder = fields.map(f => f.name);
  const meta = getFieldsFromData(sampleData, fieldOrder);
  const updatedFields = fields.map((f, i) => ({
    ...f,
    type: meta[i].type,
    format: meta[i].format,
    analyzerType: meta[i].analyzerType
  }));

  return {fields: updatedFields, rows};
}

function findNonEmptyRowsAtField(rows: unknown[][], fieldIdx: number, total: number): any[] {
  const sample: any[] = [];
  let i = 0;
  while (sample.length < total && i < rows.length) {
    if (notNullorUndefined(rows[i]?.[fieldIdx])) {
      sample.push(rows[i]);
    }
    i++;
  }
  return sample;
}

/**
 * Process saved kepler.gl json to be pass to [`addDataToMap`](../actions/actions.md#adddatatomap).
 * The json object should contain `datasets` and `config`.
 * @param rawData
 * @returns datasets and config `{datasets: {}, config: {}}`
 * @public
 * @example
 * import {addDataToMap} from 'kepler.gl/actions';
 * import {processKeplerglJSON} from 'kepler.gl/processors';
 *
 * dispatch(addDataToMap(processKeplerglJSON(keplerGlJson)));
 */
export function processKeplerglJSON(rawData: SavedMap): LoadedMap | null {
  return rawData ? KeplerGlSchema.load(rawData.datasets, rawData.config) : null;
}

/**
 * Parse a single or an array of datasets saved using kepler.gl schema
 * @param rawData
 */
export function processKeplerglDataset(rawData: unknown): ParsedDataset | ParsedDataset[] | null {
  if (!rawData) {
    return null;
  }

  const results = KeplerGlSchema.parseSavedData(toArray(rawData));
  if (!results) {
    return null;
  }
  return Array.isArray(rawData) ? results : results[0];
}

export const DATASET_HANDLERS: {
  row: typeof processRowObject;
  geojson: typeof processGeojson;
  csv: typeof processCsvData;
  keplergl: typeof processKeplerglDataset;
} = {
  [DATASET_FORMATS.row]: processRowObject,
  [DATASET_FORMATS.geojson]: processGeojson,
  [DATASET_FORMATS.csv]: processCsvData,
  [DATASET_FORMATS.keplergl]: processKeplerglDataset
};

export const Processors: {
  processGeojson: typeof processGeojson;
  processCsvData: typeof processCsvData;
  processRowObject: typeof processRowObject;
  processKeplerglJSON: typeof processKeplerglJSON;
  processKeplerglDataset: typeof processKeplerglDataset;
  analyzerTypeToFieldType: typeof analyzerTypeToFieldType;
  getFieldsFromData: typeof getFieldsFromData;
  parseCsvRowsByFieldType: typeof parseCsvRowsByFieldType;
  formatCsv: typeof formatCsv;
} = {
  processGeojson,
  processCsvData,
  processRowObject,
  processKeplerglJSON,
  processKeplerglDataset,
  analyzerTypeToFieldType,
  getFieldsFromData,
  parseCsvRowsByFieldType,
  formatCsv
};
