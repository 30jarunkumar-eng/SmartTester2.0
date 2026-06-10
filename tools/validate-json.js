'use strict';

const Ajv  = require('ajv');
const fs   = require('fs');
const path = require('path');
const chalk = require('chalk');

const ajv = new Ajv({ allErrors: true });

const SCHEMA_FILES = {
  'capture-package': path.resolve(__dirname, '../schemas/capture-package.schema.json'),
  'test-matrix':     path.resolve(__dirname, '../schemas/test-matrix.schema.json'),
  'execution-report':path.resolve(__dirname, '../schemas/execution-report.schema.json'),
};

function validateFile(dataFile, schemaName) {
  const schema   = JSON.parse(fs.readFileSync(SCHEMA_FILES[schemaName], 'utf8'));
  const data     = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const validate = ajv.compile(schema);
  const valid    = validate(data);
  if (!valid) {
    console.log(chalk.red(`✘ ${path.basename(dataFile)} invalid against ${schemaName}:`));
    validate.errors.forEach(e => console.log(`  • ${e.instancePath} ${e.message}`));
    return false;
  }
  console.log(chalk.green(`✔ ${path.basename(dataFile)} is valid (${schemaName})`));
  return true;
}

// Auto-discover and validate all artifact files in work/runs/
function validateAll() {
  const workDir = path.resolve(__dirname, '../work/runs');
  if (!fs.existsSync(workDir)) {
    console.log(chalk.yellow('No work/runs directory found. Run the pipeline first.'));
    return;
  }

  let allValid = true;
  const runs = fs.readdirSync(workDir);

  if (runs.length === 0) {
    console.log(chalk.yellow('No runs found in work/runs/'));
    return;
  }

  runs.forEach(run => {
    const runPath = path.join(workDir, run);
    if (!fs.statSync(runPath).isDirectory()) return;

    console.log(chalk.bold(`\nRun: ${run}`));

    const CHECKS = [
      { file: 'capture-package.json', schema: 'capture-package' },
      { file: 'test-matrix.json',     schema: 'test-matrix'     },
      { file: 'execution-report.json',schema: 'execution-report' },
    ];

    CHECKS.forEach(({ file, schema }) => {
      const filePath = path.join(runPath, file);
      if (fs.existsSync(filePath)) {
        const ok = validateFile(filePath, schema);
        if (!ok) allValid = false;
      }
    });
  });

  console.log('');
  if (allValid) console.log(chalk.green.bold('All artifacts are valid.'));
  else          console.log(chalk.red.bold('Some artifacts have validation errors.'));
}

validateAll();
