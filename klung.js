#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const util = require("util");
const exec = util.promisify(require("child_process").exec);

let verbose;
let superVerbose;
let compileCommands = "compile_commands.json";
let fiskc = "fiskc";
let excludes = [];
let includes = [];
let extraArgs = [];
let removeArgs = [];
let standardRemoveArgs = [];
let maxParallelJobs = 10;
let maxCount = Number.MAX_SAFE_INTEGER;

const parallelize = (promiseCreators) => {
    verbose("parallelize called with", promiseCreators.length, "jobs");
    return new Promise((resolve, reject) => {
        let idx = 0;
        let results = [];
        let active = 0;
        let rejected = false;
        const fill = () => {
            verbose(`Fill called with idx: ${idx}/${promiseCreators.length} active: ${active}`);
            while (active < maxParallelJobs && idx < promiseCreators.length) {
                const promise = promiseCreators[idx]();
                const then = (idx, result) => {
                    if (rejected) {
                        return;
                    }
                    results[idx] = result;
                    --active;
                    fill();
                };
                ++active;
                promise.then(then.bind(undefined, idx), err => {
                    if (!rejected) {
                        rejected = true;
                        reject(err);
                    }
                });
                ++idx;
            }
            if (!active) {
                resolve(results);
            };
        };
        fill();
    });
}

const sha1 = (command) => {
    return exec(`${fiskc} --fisk-dump-sha1 --fisk-compiler=${command}`).then(result => {
        const stdout = result.stdout;
        if (stdout.endsWith("\n")) {
            return stdout.substring(0, stdout.length - 1);
        }
        return stdout;
    });
}

const match = (pattern, str) => {
    if (str.includes(pattern)) {
        // console.log(str, "includes", pattern);
        return true;
    }
    // console.log(str, "does not include", pattern);
    return false;
};

const matchExact = (match, str) => {
    if (str === match) {
        // console.log(str, "===", match);
        return true;
    }
    // console.log(str, "!==", match);
    return false;
};

const matchRegex = (regex, str) => {
    if (regex.exec(str)) {
        // console.log(str, "matches", regex);
        return true;
    }
    // console.log(str, "does not match", regex);
    return false;
};

const usage = () => `klung.js ...
  [--help|-h]
  [--verbose|-v]
  [--version]
  [--compile-commands|-c <file>]
  [--fiskc <file>]
  [--exclude|-e <pattern>]
  [--exclude-regex|-r <regex>]
  [--include|-i <pattern>]
  [--include-regex|-I <regex>]
  [--remove-arg|-R <pattern>]
  [--remove-arg-regex|-x <regex>]
  [--extra-arg|-A <arg>]
  [--no-standard-remove-args]
  [--max-parallel-sha1-jobs | -s <number>]
  [--max-count|-n <number>]
`;

standardRemoveArgs.push(matchRegex.bind(undefined, /-Wa,--[0-9][0-9]/),
                        match.bind(undefined, "-fno-var-tracking-assignments"));

for (let idx=2; idx<process.argv.length; ++idx) {
    const arg = process.argv[idx];
    switch (arg) {
    case "--help":
    case "-h":
        console.log(usage());
        process.exit(0);
    case "--version":
        console.log(JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"))).version);
        process.exit(0);
    case "--verbose":
    case "-v":
        if (!verbose) {
            verbose = console.log.bind(console);
        } else {
            superVerbose = console.log.bind(console);
        }
        break;
    case "--fiskc":
        fiskc = process.argv[++idx];
        break;
    case "--compile-commands":
    case "-c":
        compileCommands = process.argv[++idx];
        try {
            if (fs.statSync(compileCommands).isDirectory()) {
                compileCommands = path.join(compileCommands, "compile_commands.json");
            }
        } catch (err) {
            console.log("Balls", err);

        }
        break;
    case "--exclude":
    case "-e":
        excludes.push(match.bind(undefined, process.argv[++idx]));
        break;
    case "--exclude-regex":
    case "-r":
        excludes.push(matchRegex.bind(undefined, new RegExp(process.argv[++idx])));
        break;
    case "--include":
    case "-i":
        includes.push(match.bind(undefined, process.argv[++idx]));
        break;
    case "--include-regex":
    case "-I":
        includes.push(matchRegex.bind(undefined, new RegExp(process.argv[++idx])));
        break;
    case "--extra-arg":
    case "-A":
        extraArgs.push(...process.argv[++idx].split(" ").filter(x => x));
        break;
    case "--remove-arg":
    case "-R":
        removeArgs.push(matchExact.bind(undefined, process.argv[++idx]));
        break;
    case "--remove-arg--regex":
    case "-x":
        removeArgs.push(matchRegex.bind(undefined, new RegExp(process.argv[++idx])));
        break;
    case "--no-standard-remove-args":
        standardRemoveArgs = [];
        break;
    case "--max-parallel-sha1-jobs":
    case "-s":
        maxParallelJobs = parseInt(process.argv[++idx]);
        if (maxParallelJobs < 0 || !maxParallelJobs) {
            console.error("Invalid --max-parallel-sha1-jobs", process.argv[idx]);
            process.exit(1);
        }
        break;
    case "--max-count":
    case "-n":
        maxCount = parseInt(process.argv[++idx]);
        if (maxCount < 0 || !maxCount) {
            console.error("Invalid --max-count", process.argv[idx]);
            process.exit(1);
        }
        break;
    }
}

if (!verbose) {
    verbose = () => {};
}

if (!superVerbose) {
    superVerbose = () => {};
}

removeArgs.push(...standardRemoveArgs);

let compilationDatabase;
try {
    compilationDatabase = JSON.parse(fs.readFileSync(compileCommands, "utf8"));
    if (!Array.isArray(compilationDatabase)) {
        throw new Error(`${compileCommands} doesn't contain the expected json`);
    }
} catch (err) {
    console.error(usage());
    console.error("Failed to load compilationDatabase", compileCommands, err.message);
    process.exit(1);
}

let count = 0;
compilationDatabase = compilationDatabase.filter(item => {
    superVerbose(item);
    if (count === maxCount) {
        // superVerbose("--max-count reached", maxCount);
        return false;
    }
    if (item.file.endsWith(".S")) {
        verbose("excluded because it's assembly", item.file);
        return false;
    }
    if (excludes.some(x => x(item.file))) {
        verbose("excluded because of excludes[]", item.file);
        return false;
    }
    if (includes.length && !includes.some(x => x(item.file))) {
        verbose("excluded because of includes[] not matching", item.file);
        return false;
    }
    const commands = item.command.split(" ").filter(arg => {
        if (removeArgs.some(x => x(arg))) {
            superVerbose("Filtered out arg", arg, "for", item.file);
            return false;
        }
        return true;
    });
    ++count;
    commands.push(...extraArgs);
    item.command = commands.join(" ");
    if (excludes.length || includes.length) {
        verbose("Included", item.file);
    }

    return true;
});

parallelize(compilationDatabase.map(item => sha1.bind(undefined, item.command))).then(results => {
    console.log(results);
});

// console.log(JSON.stringify(compilationDatabase, undefined, 4));
