/**
 * Module dependencies.
 */

var Base = require('mocha').reporters.Base
  , cursor = Base.cursor
  , color = Base.color
  , fs = require('fs')
  , path = require('path')
  , diff= require('diff')
  , mkdirp = require('mkdirp')
  , util = require('util')
  , colors = require('colors');

/**
 * Save timer references to avoid Sinon interfering (see GH-237).
 */

var Date = global.Date
  , setTimeout = global.setTimeout
  , setInterval = global.setInterval
  , clearTimeout = global.clearTimeout
  , clearInterval = global.clearInterval;

/**
 * Save original console.log.
 */
var log = console.log.bind(console);

/**
 * Expose `Jenkins`.
 */

exports = module.exports = Jenkins;

/**
 * Initialize a new `Jenkins` test reporter.
 *
 * @param {Runner} runner
 * @api public
 */

function Jenkins(runner, options) {
  Base.call(this, runner);
  var self = this,
      options = (options && options.reporterOptions) || {};
  var fd, currentSuite;

  // Default options
  options.junit_report_stack = process.env.JUNIT_REPORT_STACK || options.junit_report_stack;
  options.junit_report_path = process.env.JUNIT_REPORT_PATH || options.junit_report_path;
  options.junit_report_name = process.env.JUNIT_REPORT_NAME || options.junit_report_name || 'Mocha Tests';
  options.junit_report_packages = process.env.JUNIT_REPORT_PACKAGES || options.junit_report_packages;
  options.jenkins_reporter_enable_sonar = process.env.JENKINS_REPORTER_ENABLE_SONAR || options.jenkins_reporter_enable_sonar;
  options.jenkins_reporter_test_dir =  process.env.JENKINS_REPORTER_TEST_DIR || options.jenkins_reporter_test_dir  || 'test';

  // From http://stackoverflow.com/a/961504 modified for JavaScript
  function removeInvalidXmlChars(str) {
    // Remove invalid surrogate low bytes first, no lookbehind in JS :(
    // Should be equal to str.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    str = str.replace(/([^\ud800-\udbff])[\udc00-\udfff]|^[\udc00-\udfff]/g, '$1');
    // Remove other characters that are not valid for XML documents
    return str.replace(/[\ud800-\udbff](?![\udc00-\udfff])|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ufeff\ufffe\uffff]/g, '');
  }

  function writeString(str) {
    if (fd) {
      var buf = new Buffer(str);
      fs.writeSync(fd, buf, 0, buf.length, null);
    }
  }

  function genSuiteReport() {
    var testCount = currentSuite.failures+currentSuite.passes;
    if (currentSuite.tests.length > testCount) {
      // we have some skipped suites included
      testCount = currentSuite.tests.length;
    }
    if (testCount === 0) {
      // no tests, we can safely skip printing this suite
      return;
    }

    if (options.screenshots) {
      var imagestring = options.imagestring || htmlEscape(currentSuite.suite.fullTitle());
      var imagetype = options.imagetype || 'png';
      if (options.screenshots == 'loop') {
        var screenshotIndex = 0;
        var screenshots = [];
        var screenshot = '';
        var files = fs.readdirSync(options.junit_report_path).sort();
        for(var i in files) {
          if (files[i].indexOf(imagestring)>-1){
            screenshots.push(files[i]);
          }
        }
      }
    }

    writeString('<testsuite');
    writeString(' name="'+htmlEscape(currentSuite.suite.fullTitle())+'"');
    writeString(' tests="'+testCount+'"');
    writeString(' failures="'+currentSuite.failures+'"');
    writeString(' skipped="'+(testCount-currentSuite.failures-currentSuite.passes)+'"');
    writeString(' timestamp="'+currentSuite.start.toUTCString()+'"');
    writeString(' time="'+(currentSuite.duration/1000)+'"');
    writeString('>\n');

    var tests = currentSuite.tests;

    if (tests.length === 0 && currentSuite.failures > 0) {
      // Get the runnable that failed, which is a beforeAll or beforeEach
      tests = [currentSuite.suite.ctx.runnable()];
    }

    tests.forEach(function(test) {
      writeString('<testcase');
      writeString(' classname="'+htmlEscape(getClassName(test, currentSuite.suite))+'"');
      writeString(' name="'+htmlEscape(test.title)+'"');
      if (test.duration) {
        writeString(' time="'+(test.duration/1000)+'"');
      }
      writeString('>\n');
      if (test.state == "failed") {
        writeString('<failure message="');
        if (test.err.message) writeString(htmlEscape(test.err.message));
        writeString('">\n');
        writeString(htmlEscape(unifiedDiff(test.err)));
        writeString('\n</failure>\n');

        //screenshot name is either pulled in sorted order from junit_report_path
        //or set as suitename + classname + title, then written with Jenkins ATTACHMENT tag
        if (options.screenshots) {
          var screenshotDir = path.join(process.cwd(), options.junit_report_path);
          if (options.screenshots == 'loop') {
            screenshot = path.join(screenshotDir, screenshots[screenshotIndex]);
            screenshotIndex++;
          } else {
            screenshot = path.join(screenshotDir, imagestring +
                getClassName(test, currentSuite.suite) + test.title + "." + imagetype);
          }
          writeString('<system-out>\n');
          writeString('[[ATTACHMENT|' + screenshot + ']]\n');
          writeString('</system-out>\n');
        }
      } else if(test.state === undefined) {
        writeString('<skipped/>\n');
      }

      if (test.logEntries && test.logEntries.length) {
        writeString('<system-out><![CDATA[');
        test.logEntries.forEach(function (entry) {
          var outstr = util.format.apply(util, entry) + '\n';
          outstr = removeInvalidXmlChars(outstr);
          // We need to escape CDATA ending tags inside CDATA
          outstr = outstr.replace(/]]>/g, ']]]]><![CDATA[>')
          writeString(outstr);
        });
        writeString(']]></system-out>\n');
      }

      writeString('</testcase>\n');
    });

    writeString('</testsuite>\n');
  }

  function startSuite(suite) {
    currentSuite = {
      suite: suite,
      tests: [],
      start: new Date,
      failures: 0,
      passes: 0
    };
    log();
    log("  "+suite.fullTitle());
  }

  function endSuite() {
    if (currentSuite != null) {
      currentSuite.duration = new Date - currentSuite.start;
      try {
      genSuiteReport();
      } catch (err) { log(err) }
      currentSuite = null;
    }
  }

  function addTestToSuite(test) {
    currentSuite.tests.push(test);
  }

  function indent() {
    return "    ";
  }

  function htmlEscape(str) {
      return String(str)
              .replace(/&/g, '&amp;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#39;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
  }

  function unifiedDiff(err) {
    function escapeInvisibles(line) {
      return line.replace(/\t/g, '<tab>')
                 .replace(/\r/g, '<CR>')
                 .replace(/\n/g, '<LF>\n');
    }
    function cleanUp(line) {
      if (line.match(/\@\@/)) return null;
      if (line.match(/\\ No newline/)) return null;
      return escapeInvisibles(line);
    }
    function notBlank(line) {
      return line != null;
    }

    var actual = err.actual,
        expected = err.expected;

    var lines, msg = '';

    if (err.actual && err.expected) {
      // make sure actual and expected are strings
      if (!(typeof actual === 'string' || actual instanceof String)) {
        actual = JSON.stringify(err.actual);
      }

      if (!(typeof expected === 'string' || expected instanceof String)) {
        expected = JSON.stringify(err.actual);
      }

      msg = diff.createPatch('string', actual, expected);
      lines = msg.split('\n').splice(4);
      msg += lines.map(cleanUp).filter(notBlank).join('\n');
    }

    if (options.junit_report_stack && err.stack) {
      if (msg) msg += '\n';
      lines = err.stack.split('\n').slice(1);
      msg += lines.map(cleanUp).filter(notBlank).join('\n');
    }

    return msg;
  }

  function getRelativePath(test) {
    var relativeTestDir = options.jenkins_reporter_test_dir,
        absoluteTestDir = path.join(process.cwd(), relativeTestDir);
    return path.relative(absoluteTestDir, test.file);
  }

  function getClassName(test, suite) {
    if (options.jenkins_reporter_enable_sonar) {
      // Inspired by https://github.com/pghalliday/mocha-sonar-reporter
      var relativeFilePath = getRelativePath(test),
          fileExt = path.extname(relativeFilePath);
      return relativeFilePath.replace(new RegExp(fileExt+"$"), '');
    }
    if (options.junit_report_packages) {
      var testPackage = getRelativePath(test).replace(/[^\/]*$/, ''),
          delimiter = testPackage ? '.' : '';
      return testPackage + delimiter + suite.fullTitle();
    }
    return suite.fullTitle();
  }

  runner.on('start', function() {
    var reportPath = options.junit_report_path;
    var suitesName = options.junit_report_name;
    if (reportPath) {
      if (fs.existsSync(reportPath)) {
        var isDirectory = fs.statSync(reportPath).isDirectory();
        if (isDirectory) reportPath = path.join(reportPath, new Date().getTime() + ".xml");
      } else {
        mkdirp.sync(path.dirname(reportPath));
      }
      fd = fs.openSync(reportPath, 'w');
    }
    writeString('<testsuites name="' + suitesName + '">\n');
  });

  runner.on('end', function() {
    endSuite();
    writeString('</testsuites>\n');
    if (fd) fs.closeSync(fd);
    self.epilogue.call(self);
  });

  runner.on('suite', function (suite) {
    if (currentSuite) {
      endSuite();
    }
    startSuite(suite);
  });

  runner.on('test', function (test) {
    test.logEntries = [];
    console.log = function () {
      log.apply(this, arguments);
      test.logEntries.push(Array.prototype.slice.call(arguments));
    };
  });

  runner.on('test end', function(test) {
    addTestToSuite(test);
    console.log = log;
  });

  runner.on('pending', function(test) {
    var fmt = indent()
      + '  - '
      + test.title;
    log(colors.yellow(fmt));
  });

  runner.on('pass', function(test) {
    currentSuite.passes++;
    var fmt = indent()
      + ' ' + Base.symbols.ok + ' '
      + test.title
   log(colors.green(fmt));
  });

  runner.on('fail', function(test, err) {
    var n = ++currentSuite.failures;
    var fmt = indent()
      + n + ') ' + test.title
    log(colors.red(fmt));
  });
}

Jenkins.prototype.__proto__ = Base.prototype;
