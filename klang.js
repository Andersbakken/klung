#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");

const usage = "klang.js [--port|-p <port>] [--dir|-d <dir>] [--help|-h] [--verbose|-v] [--max-entries|-m <count]";

let data = "./data";
let port = 6677;
let maxEntries = 50000;
let verbose = () => {};
let filesArray;
let filesSet;
let watchSuspended = false;

function clean()
{
    return new Promise(resolve => {
        fs.readdir(data, (err, f) => {
            if (err) {
                console.error("Got an error cleaning files", err); // quit?
                return;
            }
            filesArray = f;
            filesSet = new Set(f);
            verbose("files", f.length, "maxEntries", maxEntries);
            if (f.length <= maxEntries) {
                resolve();
                return;
            }

            const filesAndStat = f.map(file => {
                try {
                    const filePath = path.join(data, file);
                    const stat = fs.statSync(filePath);
                    return { filePath, stat, file };
                } catch (err) {
                    console.error("Couldn't stat file", path.join(data, file));
                    return undefined;
                }
            }).filter(x => x).sort((l, r) => {
                return l.stat.mtimeMs - r.stat.mtimeMs;
            });
            for (let idx=0; idx<filesAndStat.length - maxEntries; ++idx) {
                verbose("removing file", filesAndStat[idx].filePath);
                fs.unlinkSync(filesAndStat[idx].filesAndStat);
                filesSet.delete(filesAndStat[idx].file);
            }
            filesArray.splice(0, filesAndStat.length - maxEntries);
            resolve();
        });
    });
}

function touch(file)
{
    fs.closeSync(fs.openSync(path.join(data, file), "a"));
}

for (let idx=2; idx<process.argv.length; ++idx) {
    switch (process.argv[idx]) {
    case "--help":
    case "-h":
        console.log(usage);
        process.exit(0);
    case "--verbose":
    case "-v":
        verbose = console.log.bind(console);
        break;
    case "--port":
    case "-p":
        port = parseInt(process.argv[++idx]);
        if (port < 0 || !port || port > 2 ** 16) {
            console.error(usage);
            console.error("Invalid port", process.argv[idx]);
            process.exit(1);
        }
        break;
    case "--max-entries":
    case "-m":
        maxEntries = parseInt(process.argv[++idx]);
        if (maxEntries < 0 || !maxEntries) {
            console.error(usage);
            console.error("Invalid --max-entries", process.argv[idx]);
            process.exit(1);
        }
        break;
    case "--dir":
    case "-d":
        data = process.argv[++idx];
        break;
    default:
        console.error(usage);
        console.error("Unknown argument", process.argv[idx]);
        process.exit(1);
    }
}

try {
    fs.mkdirSync(data, { recurse: true });
} catch (err) {
    if (err.code !== "EEXIST") {
        console.error("Can't create directory", data, err);
        process.exit(1);
    }
}

const server = http.createServer((req, res) => {   // 2 - creating server
    if (req.method === "GET") {
        switch (req.url) {
        case "/clear":
        case "/list":
            if (req.url === "/clear") {
                filesArray.forEach(x => fs.unlink(path.join(data, x)));
                verbose("Cleared", filesArray.length, "entries");
                filesArray = [];
                filesSet = new Set();
            } else {
                res.end(filesArray.join("\n") + "\n");
            }
            return;
        default:
            res.writeHead(404);
            res.end();
            return;
        }
    }
    // console.log(req);
    if (req.method !== "POST") {
        console.log(res);
        res.writeHead(403);
        res.end();
        return;
    }

    let query;
    switch (req.url) {
    case "/query":
        query = true;
        break;
    case "/commit":
        query = false;
        break;
    default:
        res.writeHead(404);
        res.end();
        return;
    }

    // console.log(req.url, req.path);
    let body = "";;

    req.on("data", data => {
        body += data;
    });

    req.on("end", () => {
        console.log(body);
        let files;
        if (body.includes(",")) {
            files = body.split(",").filter(x => x);
        } else {
            files = body.split("\n").filter(x => x);
        }
        verbose("got data", query ? "query" : "commit", files);
        watchSuspended = true;
        if (query) {
            res.end(files.map(x => {
                if (filesSet.has(x)) {
                    touch(x);
                    return 1;
                }
                return 0;
            }).join("") + "\n");
        } else {
            files.forEach(file => {
                if (!filesSet.has(file)) {
                    filesSet.add(file);
                    filesArray.push(file);
                }
                touch(file);
            });
            res.end();
        }
        watchSuspended = false;
    });
});

clean().then(f => {
    verbose("Listening on port", port, "dir", data);
    server.listen(port);
    setInterval(clean, 60 * 1000 * 1000);
    let cleanPending = false;
    fs.watch(data, event => {
        verbose(event, watchSuspended);
        if (watchSuspended || cleanPending) {
            return;
        }
        cleanPending = true;
        setTimeout(() => {
            clean().then(() => {
                cleanPending = false;
            });
        }, 1000);
    });
});
