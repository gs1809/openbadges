var mysql = require('../lib/mysql');
var regex = require('../lib/regex');
var crypto = require('crypto');
var Utils = require('../lib/utils');
var Base = require('./mysql-base');
var Portfolio = require('./portfolio');
var async = require('async');
var _ = require('underscore');

function sha256(value) {
  var sum = crypto.createHash('sha256');
  sum.update(value);
  return sum.digest('hex');
}

var Badge = function (attributes) {
  this.attributes = attributes;
};

Base.apply(Badge, 'badge');

Badge.prototype.presave = function () {
  if (!this.get('id')) {
    this.set('body_hash', sha256(this.get('body')));
  }
};

Badge.confirmRecipient = function confirmRecipient(assertion, email) {
  // can't validate if not given an assertion
  if (!assertion) return false;

  var badgeEmail = assertion.recipient;
  var salt = assertion.salt || '';

  if (!badgeEmail || !email) return false;

  // if it's an email address, do a straight comparison
  if (/@/.test(badgeEmail)) return badgeEmail === email;

  // if it's not an email address, it must have an alg and dollar sign.
  if (!(badgeEmail.match(/\w+(\d+)?\$.+/))) return false;

  var parts = badgeEmail.split('$');
  var algorithm = parts[0];
  var hash = parts[1];
  var given = crypto.createHash(algorithm);

  // if there are only two parts, the first part is the algorithm and the
  // second part is the computed hash.
  if (parts.length === 2) {
    return given.update(email + salt).digest('hex') === hash;
  }
  // if there are more parts, it's an algorithm with options
  else {
    // #TODO: support algorithms with options.
    return false;
  }
};

Badge.prototype.confirmRecipient = function confirmRecipient(email) {
  return Badge.confirmRecipient(this.get('body'), email);
};


Badge.prototype.checkHash = function checkHash() {
  return sha256(JSON.stringify(this.get('body'))) === this.get('body_hash');
};

// Validators called by `save()` (see mysql-base) in preparation for saving.
// A valid pass returns nothing (or a falsy value); an invalid pass returns a
// message about why a thing was invalid.

// #TODO: return either null or Error objects with more information about
// what's going on.

// TODO: make these errors more than strings so we don't have to parse
// them to figure out how to handle the error
Badge.validators = {
  type: function (value, attributes) {
    var valid = ['signed', 'hosted'];
    if (valid.indexOf(value) === -1) {
      return "Unknown type: " + value;
    }
    if (value === 'hosted' && !attributes.endpoint) {
      return "If type is hosted, endpoint must be set";
    }
    if (value === 'signed' && !attributes.jwt) {
      return "If type is signed, jwt must be set";
    }
    if (value === 'signed' && !attributes.public_key) {
      return "If type is signed, public_key must be set";
    }
  },
  endpoint: function (value, attributes) {
    if (!value && attributes.type === 'hosted') {
      return "If type is hosted, endpoint must be set";
    }
  },
  jwt: function (value, attributes) {
    if (!value && attributes.type === 'signed') {
      return "If type is signed, jwt must be set";
    }
  },
  public_key: function (value, attributes) {
    if (!value && attributes.type === 'signed') {
      return "If type is signed, public_key must be set";
    }
  },
  image_path: function (value) {
    if (!value) { return "Must have an image_path."; }
  },
  body: function (value) {
    if (!value) { return "Must have a body."; }
    if (String(value) !== '[object Object]') { return "body must be an object"; }
    if (Badge.validateBody(value) instanceof Error) { return "invalid body"; }
  }
};

// Prepare a field as it goes into or comes out of the database.
Badge.prepare = {
  'in': { body: function (value) { return JSON.stringify(value); } },
  'out': { body: function (value) { return JSON.parse(value); } }
};

// Virtual finders. By default, `find()` will take the keys of the criteria
// and create WHERE statements based on those. This object provides more
// nuanced control over how the query is formed and also allows creation
// of finders that don't map directly to a column name.
Badge.finders = {
  email: function (value, callback) {
    var query = "SELECT * FROM `badge` WHERE `user_id` = (SELECT `id` FROM `user` WHERE `email` = ?)";
    mysql.client.query(query, [value], callback);
  }
};

function getBadgeInfo(badgeIdUrl, callback) {
  var badgeId = badgeIdUrl[1];
  var portfolioUrl = badgeIdUrl[0];
  Badge.findById(badgeId, function (err, badge){
    var badgeInfo =  {
      /*lastValidated: badge.get('validated_on'),
      assertionType: badge.get('type'),
      hostedUrl: badge.get('endpoint'),
      assertion: badge.get('body'),*/
      imageUrl: Utils.fullUrl(badge.get('image_path')),
      portfolioUrl : portfolioUrl
    };

    callback(null, badgeInfo);
  });
}

Badge.getAllPublicBadges = function (userId, callback) {
  var Group = require('./group'); // need require here because of circular dependency 
  Group.find({user_id : userId, 'public' : 1}, function (err, groups) {
    var groupsAgg = _.map(groups, function (group){
      var portfolioUrl = Utils.fullUrl("/share/" + group.get('url'));
      return _.map(group.get('badges'), function(badge){
        return [portfolioUrl, badge];
      });
    });
    
    groupsAgg = _.reduce(groupsAgg, function(a, b){ return a.concat(b);}, []);
    groupsAgg = _.unique(groupsAgg, function (item) { return item[1];});
    async.map(groupsAgg, getBadgeInfo, function (err, badgeInfoObj){
      callback(badgeInfoObj);
    });
  });
};

// Validate the structure and values of the body field, which contains the
// badge assertion as received from the issuer. Returns an error object with a
// `fields` attribute describing the errors if invalid, and `undefined` if
// valid.
Badge.validateBody = function (body) {
  var err = new Error('Invalid badge assertion');
  err.fields = {};

  var internalClass = Object.prototype.toString.call(body);
  if (!body || internalClass !== '[object Object]') {
    err.message = 'Invalid badge assertion: invalid body';
    return err
  }

  function fieldFromDottedString (str, obj) {
    var fields = str.split('.');
    var current = obj;
    var previous = null;
    fields.forEach(function (f) {
      previous = current;
      current = current[f];
    });
    return previous[fields.pop()];
  }

  var test = {
    missing: function (fieldStr) {
      var field = fieldFromDottedString(fieldStr, body);
      if (!field) {
        err.fields[fieldStr] = 'missing required field: `' + fieldStr + '`';
      }
    },
    regexp: function (fieldStr, type) {
      var field = fieldFromDottedString(fieldStr, body);
      if (field && !regex[type].test(field)) {
        err.fields[fieldStr] = 'invalid ' + type + ' for `' + fieldStr + '`';
      }
    },
    length: function (fieldStr, maxlength) {
      var field = fieldFromDottedString(fieldStr, body);
      if (field && field.length > maxlength) {
        err.fields[fieldStr] = 'invalid value for `' + fieldStr + '`: too long, maximum length should be ' + maxlength;
      }
    }
  };

  // begin tests
  test.missing('recipient');
  test.regexp('recipient', 'emailOrHash');
  test.regexp('evidence', 'url');
  test.regexp('expires', 'date');
  test.regexp('issued_on', 'date');
  if (!body.badge) {
    err.fields['badge'] = 'missing required field `badge`';
  } else {
    test.missing('badge.version');
    test.missing('badge.name');
    test.missing('badge.description');
    test.missing('badge.criteria');
    test.missing('badge.image');
    test.regexp('badge.version', 'version');
    test.regexp('badge.image', 'url');
    test.regexp('badge.criteria', 'url');
    test.length('badge.name', 128);
    test.length('badge.description', 128);
    if (!body.badge.issuer) {
      err.fields['badge.issuer'] = 'missing required field `badge.issuer`';
    } else {
      test.missing('badge.issuer.origin');
      test.missing('badge.issuer.name');
      test.regexp('badge.issuer.origin', 'origin');
      test.regexp('badge.issuer.contact', 'email');
      test.length('badge.issuer.org', 128);
      test.length('badge.issuer.name', 128);
    }
  }
  if (Object.keys(err.fields).length) { return err; }
  return null;
};
module.exports = Badge;
