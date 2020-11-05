'use strict';

const { sha256 } = require('@arangodb/crypto');

const { query, db } = require('@arangodb');

const _ = require('lodash');

const connectionsColl = db._collection('connections');
const groupsColl = db._collection('groups');
const usersInGroupsColl = db._collection('usersInGroups');
const usersColl = db._collection('users');
const contextsColl = db._collection('contexts');
const appsColl = db._collection('apps');
const sponsorshipsColl = db._collection('sponsorships');
const operationsColl = db._collection('operations');
const invitationsColl = db._collection('invitations');
const verificationsColl = db._collection('verifications');
const variablesColl = db._collection('variables');

const {
  uInt8ArrayToB64,
  b64ToUrlSafeB64,
  urlSafeB64ToB64
} = require('./encoding');

function addConnection(key1, key2, timestamp) {
  // this function is deprecated and will be removed on v6
  connect({id1: key1, id2: key2, timestamp});
  connect({id1: key2, id2: key1, timestamp});
}

function connect(op) {
  let {
    id1: key1,
    id2: key2,
    level,
    reportReason,
    replacedWith,
    requestProof,
    timestamp
  } = op;
  // create user by adding connection if it's not created
  // todo: we should prevent non-verified users from creating new users by making connections.
  let u1 = loadUser(key1);
  let u2 = loadUser(key2);
  if (!u1) {
    u1 = createUser(key1, timestamp);
  }
  if (!u2) {
    u2 = createUser(key2, timestamp);
  }

  // set the first verified user that connect to a user as its parent
  const u1_verifications = userVerifications(key1);
  if (!u2.parent && u1_verifications && u1_verifications.includes('BrightID')) {
    usersColl.update(u2, { parent: key1 });
  }


  const _from = 'users/' + key1;
  const _to = 'users/' + key2;
  const conn = connectionsColl.firstExample({ _from, _to });

  if (level != 'reported') {
    // clear reportReason for levels other than reported
    reportReason = null;
  }
  if (level != 'reported' || reportReason != 'replaced') {
    // clear replacedWith for levels other than reported
    // and reportReason other than replaced
    replacedWith = null;
  }
  if (replacedWith && ! loadUser(replacedWith)) {
    throw 'the new brightid replaced with the reported brightid not found';
  }
  if (! level) {
    // Set 'just met' as confidence level when old addConnection is called
    // and there was no other level set directly using Connect
    // this if should be removed when v5 dropped and "Add Connection" operation removed
    level = conn ? conn.level : 'just met';
  }
  if (level == 'recovery' && conn && conn.level == 'recovery') {
    // do not update timestamp when updating recovery connections because
    // recovery connections can not help recovering before a cooling time
    timestamp = conn.timestamp;
  }

  // users should provide requestProof or have connections with already known
  // or higher level to be able to report someone
  // requestProof can not be reused to report someone
  if (level == 'reported') {
    if (!requestProof || connectionsColl.firstExample({ requestProof })) {
      const otherSideConn = connectionsColl.firstExample({
        _from: _to,
        _to: _from
      });
      const otherSideLevel = otherSideConn && otherSideConn.level;
      if (!['recovery', 'already known'].includes(otherSideLevel)) {
        throw 'not allowed to report';
      }
    }
  }

  if (! conn) {
    connectionsColl.insert({ _from, _to, level, reportReason, replacedWith, requestProof, timestamp });
  } else {
    connectionsColl.update(conn, { level, reportReason, replacedWith, requestProof, timestamp });
  }
}

function removeConnection(reporter, reported, reportReason, timestamp) {
  // this function is deprecated and will be removed on v6
  connect({
    id1: reporter,
    id2: reported,
    level: 'reported',
    reportReason,
    timestamp
  });
}

function userConnections(userId) {
  let outs = connectionsColl.byExample({
    _from: 'users/' + userId
  }).toArray();
  let ins = connectionsColl.byExample({
    _to: 'users/' + userId
  }).toArray();

  outs = outs.filter(u => u.level != 'reported');
  outs = _.keyBy(outs, u => u._to.replace("users/", ""));
  ins = ins.filter(u => u.level != 'reported');
  ins = _.keyBy(ins, u => u._from.replace("users/", ""));
  const users = _.intersection(Object.keys(ins), Object.keys(outs));

  return usersColl.documents(users).documents.map(u => {
    const res = {
      id: u._key,
      signingKey: u.signingKey,
      // score is deprecated and will be removed on v6
      score: u.score,
      level: outs[u._key].level,
      verifications: userVerifications(u._key),
      hasPrimaryGroup: hasPrimaryGroup(u._key),
      // trusted is deprecated and will be replaced by recoveryConnections on v6
      trusted: getRecoveryConnections(u._key),
      // flaggers is deprecated and will be replaced by reporters on v6
      flaggers: getReporters(u._key),
      createdAt: u.createdAt,
      // eligible_groups is deprecated and will be replaced by eligibleGroups on v6
      eligible_groups: u.eligible_groups || []
    }
    return res;
  });
}

function getReporters(user) {
  const reporters = {};
  connectionsColl.byExample({
    _to: 'users/' + user,
    level: 'reported'
  }).toArray().forEach(c => {
    reporters[c._from.replace('users/', '')] = c.reportReason;
  });
  return reporters;
}

function groupMembers(groupId) {
  return usersInGroupsColl.byExample({
    _to: "groups/" + groupId,
  }).toArray().map(e => e._from.replace('users/', ''));
}

function isEligible(groupId, userId) {
  const conns = connectionsColl.byExample({
    _to: 'users/' + userId
  }).toArray().map(u => u._from.replace("users/", ""));
  const members = groupMembers(groupId);
  const count = _.intersection(conns, members).length;
  return count >= members.length / 2;
}

function updateEligibleGroups(userId, connections, currentGroups) {
  connections = connections.map(uId => 'users/' + uId);
  currentGroups = currentGroups.map(gId => 'groups/' + gId);
  const user = "users/" + userId;
  const candidates = query`
      FOR edge in ${usersInGroupsColl}
          FILTER edge._from in ${connections}
          FILTER edge._to NOT IN ${currentGroups}
          COLLECT group=edge._to WITH COUNT INTO count
          SORT count DESC
          RETURN {
              group,
              count
          }
  `.toArray();
  const groupIds = candidates.map(x => x.group);
  const groupCounts = query`
    FOR ug in ${usersInGroupsColl}
      FILTER ug._to in ${groupIds}
      COLLECT id=ug._to WITH COUNT INTO count
      return {
        id,
        count
      }
  `.toArray();

  const groupCountsDic = {};

  groupCounts.map(function(row) {
    groupCountsDic[row.id] = row.count;
  });

  const eligible_groups = candidates
    .filter(g => g.count * 2 >= groupCountsDic[g.group])
    .map(g => g.group.replace('groups/', ''));
  usersColl.update(userId, {
    eligible_groups,
    eligible_timestamp: Date.now()
  });
  return eligible_groups;
}

function updateEligibles(groupId) {
  const members = groupMembers(groupId);
  const neighbors = [];
  members.forEach(member => {
    const conns = connectionsColl.byExample({
      _from: 'users/' + member
    }).toArray().map(u => u._to.replace("users/", ""));
    neighbors.push(...conns);
  });
  const counts = {};
  for (let i = 0; i < neighbors.length; i++) {
    counts[neighbors[i]] = (counts[neighbors[i]] || 0) + 1;
  }
  Object.keys(counts).forEach(neighbor => {
    if (counts[neighbor] >= members.length / 2) {
      const eligible_groups = usersColl.document(neighbor).eligible_groups || [];
      if (eligible_groups.indexOf(groupId) == -1) {
        eligible_groups.push(groupId);
        usersColl.update(neighbor, {
          eligible_groups
        });
      }
    }
  });
}

function groupToDic(group) {
  return {
    id: group._key,
    members: groupMembers(group._key),
    type: group.type || 'general',
    founders: group.founders.map(founder => founder.replace('users/', '')),
    admins: group.admins || group.founders,
    isNew: group.isNew,
    // score on group is deprecated and will be removed on v6
    score: 0,
    url: group.url,
    timestamp: group.timestamp,
  }
}

function userGroups(userId) {
  return usersInGroupsColl.byExample({
    _from: 'users/' + userId
  }).toArray().map(
    ug => {
      let group = groupsColl.document(ug._to);
      group = groupToDic(group);
      group.joined = ug.timestamp;
      return group;
    }
  );
}

function userInvitedGroups(userId) {
  return invitationsColl.byExample({
    _from: 'users/' + userId
  }).toArray().filter(invite => {
    return Date.now() - invite.timestamp < 86400000
  }).map(invite => {
    let group = groupsColl.document(invite._to);
    group = groupToDic(group);
    group.inviter = invite.inviter;
    group.inviteId = invite._key;
    group.data = invite.data;
    group.invited = invite.timestamp;
    return group;
  });
}

function invite(inviter, invitee, groupId, data, timestamp) {
  if (! groupsColl.exists(groupId)) {
    throw 'invalid group id';
  }
  const group = groupsColl.document(groupId);
  if (! group.admins || ! group.admins.includes(inviter)) {
    throw 'inviter is not admin of group';
  }
  if (! isEligible(groupId, invitee)) {
    throw 'invitee is not eligible to join this group';
  }
  if (group.type == 'primary' && hasPrimaryGroup(invitee)) {
    throw 'user already has a primary group';
  }
  if (group.isNew && ! group.founders.includes(invitee)) {
    throw 'new members can not be invited before founders join the group'
  }
  invitationsColl.removeByExample({
    _from: 'users/' + invitee,
    _to: 'groups/' + groupId
  });
  invitationsColl.insert({
    _from: 'users/' + invitee,
    _to: 'groups/' + groupId,
    inviter,
    data,
    timestamp
  });
}

function dismiss(dismisser, dismissee, groupId, timestamp) {
  if (! groupsColl.exists(groupId)) {
    throw 'invalid group id';
  }
  const group = groupsColl.document(groupId);
  if (! group.admins || ! group.admins.includes(dismisser)) {
    throw 'dismisser is not admin of group';
  }
  deleteMembership(groupId, dismissee, timestamp);
}

function loadUser(id) {
  return query`RETURN DOCUMENT(${usersColl}, ${id})`.toArray()[0];
}

function userScore(key) {
  return query`
    FOR u in ${usersColl}
      FILTER u._key  == ${key}
      RETURN u.score
  `.toArray()[0];
}

function createUser(key, timestamp) {
  // already exists?
  const user = loadUser(key);

  if (!user) {
    return usersColl.insert({
      score: 0,
      signingKey: urlSafeB64ToB64(key),
      createdAt: timestamp,
      _key: key
    });
  } else {
    return user;
  }
}

function hasPrimaryGroup(key) {
  const groupIds = usersInGroupsColl.byExample({
    _from: 'users/' + key
  }).toArray().map(ug => ug._to.replace('groups/', ''));
  const groups = groupsColl.documents(groupIds).documents;
  return groups.filter(group => group.type == 'primary').length > 0;
}

function createGroup(groupId, key1, key2, inviteData2, key3, inviteData3, url, type, timestamp) {
  if (! ['general', 'primary'].includes(type)) {
    throw 'invalid type';
  }

  if (groupsColl.exists(groupId)) {
    throw 'duplicate group';
  }

  const conns = connectionsColl.byExample({
    _to: 'users/' + key1
  }).toArray().map(u => u._from.replace("users/", ""));
  if (conns.indexOf(key2) < 0 || conns.indexOf(key3) < 0) {
    throw "One or both of the co-founders are not connected to the founder!";
  }

  const founders = [key1, key2, key3].sort()
  if (type == 'primary' && founders.some(hasPrimaryGroup)) {
    throw 'some of founders already have primary groups';
  }

  groupsColl.insert({
    _key: groupId,
    score: 0,
    isNew: true,
    admins: founders,
    url,
    type,
    timestamp,
    founders
  });

  // Add the creator and invite other cofounders to the group now.
  // The other two "co-founders" have to join using /membership
  addUserToGroup(groupId, key1, timestamp);
  invite(key1, key2, groupId, inviteData2, timestamp);
  invite(key1, key3, groupId, inviteData3, timestamp);
}

function addAdmin(key, admin, groupId) {
  if (! groupsColl.exists(groupId)) {
    throw 'group not found';
  }
  if (! usersInGroupsColl.firstExample({
    _from: 'users/' + admin,
    _to: 'groups/' + groupId
  })) {
    throw 'new admin is not member of the group';
  }
  const group = groupsColl.document(groupId);
  if (! group.admins || ! group.admins.includes(key)) {
    throw 'only admins can add new admins';
  }
  group.admins.push(admin);
  groupsColl.update(group, { admins: group.admins });
}

function addUserToGroup(groupId, key, timestamp) {
  const user = 'users/' + key;
  const group = 'groups/' + groupId;

  const edge = usersInGroupsColl.firstExample({
    _from: user,
    _to: group
  });
  if (! edge) {
    usersInGroupsColl.insert({
      _from: user,
      _to: group,
      timestamp
    });
  } else {
    usersInGroupsColl.update(edge, { timestamp });
  }

}

function addMembership(groupId, key, timestamp) {
  if (! groupsColl.exists(groupId)) {
    throw 'Group not found';
  }

  const group = groupsColl.document(groupId);
  if (group.isNew && ! group.founders.includes(key)) {
    throw 'Access denied';
  }

  if (group.type == 'primary' && hasPrimaryGroup(key)) {
    throw 'user already has a primary group';
  }

  if (! isEligible(groupId, key)) {
    throw 'Not eligible to join this group';
  }

  const invite = invitationsColl.firstExample({
    _from: 'users/' + key,
    _to: 'groups/' + groupId
  });
  // invites will expire after 24 hours
  if (!invite || timestamp - invite.timestamp >= 86400000) {
    throw 'not invited to join this group';
  }
  // remove invite after joining to not allow reusing that
  invitationsColl.remove(invite);

  addUserToGroup(groupId, key, timestamp);

  if (groupMembers(groupId).length == group.founders.length) {
    groupsColl.update(group, { isNew: false });
  }
  updateEligibles(groupId);
}

function deleteGroup(groupId, key, timestamp) {
  if (! groupsColl.exists(groupId)) {
    throw 'Group not found';
  }

  const group = groupsColl.document(groupId);
  if (group.admins.indexOf(key) < 0) {
    throw 'Access Denied';
  }

  invitationsColl.removeByExample({ _to: 'groups/' + groupId });
  usersInGroupsColl.removeByExample({ _to: 'groups/' + groupId });
  groupsColl.remove(group);
}

function deleteMembership(groupId, key, timestamp) {
  if (! groupsColl.exists(groupId)) {
    throw 'group not found';
  }
  const group = groupsColl.document(groupId);
  if (group.admins && group.admins.includes(key)) {
    const admins = group.admins.filter(admin => key != admin);
    if (admins.length == 0) {
      throw 'last admin can not leave the group';
    }
    groupsColl.update(group, { admins });
  }
  usersInGroupsColl.removeByExample({
    _from: "users/" + key,
    _to: "groups/" + groupId,
  });
}

function getContext(context) {
  return contextsColl.exists(context) ? contextsColl.document(context) : null;
}

function getApp(app) {
  return appsColl.exists(app) ? appsColl.document(app) : null;
}

function getApps() {
  return appsColl.all().toArray();
}

function appToDic(app) {
  return {
    id: app._key,
    name: app.name,
    context: app.context,
    verification: getContext(app.context).verification,
    verificationUrl: app.verificationUrl,
    logo: app.logo,
    url: app.url,
    unusedSponsorships: unusedSponsorship(app._key),
    assignedSponsorships: app.totalSponsorships,
  };
}

function getUserByContextId(coll, contextId) {
  return query`
    FOR l in ${coll}
      FILTER l.contextId == ${contextId}
      RETURN l.user
  `.toArray()[0];
}

function getContextIdsByUser(coll, id) {
  return query`
    FOR u in ${coll}
      FILTER u.user == ${id}
      SORT u.timestamp DESC
      RETURN u.contextId
  `.toArray();
}

function getLastContextIds(coll, verification) {
  return query`
    FOR c IN ${coll}
      FOR u in ${usersColl}
        FILTER c.user == u._key
        FOR v in verifications
          FILTER v.user == u._key
          FILTER ${verification} == v.name
          FOR s IN ${sponsorshipsColl}
            FILTER s._from == u._id
            SORT c.timestamp DESC
            COLLECT user = c.user INTO contextIds = c.contextId
            RETURN contextIds[0]
  `.toArray();
}

function userVerifications(user) {
  return verificationsColl.byExample({
    user
  }).toArray().map(v => v.name);
}

function linkContextId(id, context, contextId, timestamp) {
  const { collection, idsAsHex } = getContext(context);
  const coll = db._collection(collection);
  if (idsAsHex) {
    contextId = contextId.toLowerCase();
  }

  const links = coll.byExample({user: id}).toArray();
  const recentLinks = links.filter(
    link => timestamp - link.timestamp < 24*3600*1000
  );
  if (recentLinks.length >=3) {
    throw 'only three contextIds can be linked every 24 hours';
  }

  // accept link if the contextId is used by the same user before
  let link;
  for (link of links) {
    if (link.contextId === contextId) {
      if (timestamp > link.timestamp) {
        coll.update(link, { timestamp });
      }
      return;
    }
  }

  if (getUserByContextId(coll, contextId)) {
    throw 'contextId is duplicate';
  }

  coll.insert({
    user: id,
    contextId,
    timestamp
  });
}

function setRecoveryConnections(conns, key, timestamp) {
  // this function is deprecated and will be removed on v6
  conns.forEach(conn => {
    connect({
      id1: key,
      id2: conn,
      level: 'recovery',
      timestamp
    });
  });
}

function getRecoveryConnections(user) {
  return connectionsColl.byExample({
    _from: 'users/' + user,
    level: 'recovery'
  }).toArray().map(c => c._to.replace('users/', ''));
}

function setSigningKey(signingKey, key, signers, timestamp) {
  const recoveryConnections = getRecoveryConnections(key);
  if (signers[0] == signers[1] ||
      !recoveryConnections.includes(signers[0]) ||
      !recoveryConnections.includes(signers[1])) {
    throw "request should be signed by 2 different recovery connections";
  }
  usersColl.update(key, {
    signingKey,
    updateTime: timestamp
  });
}

function isSponsored(key) {
  return sponsorshipsColl.firstExample({ '_from': 'users/' + key }) != null;
}

function unusedSponsorship(app) {
  const usedSponsorships = sponsorshipsColl.byExample({
    _to: 'apps/' + app
  }).count();
  const { totalSponsorships } = appsColl.document(app);
  return totalSponsorships - usedSponsorships;
}

function sponsor(user, app, timestamp) {

  if (unusedSponsorship(app) < 1) {
    throw "app does not have unused sponsorships";
  }

  if (isSponsored(user)) {
    throw "sponsored before";
  }

  sponsorshipsColl.insert({
    _from: 'users/' + user,
    _to: 'apps/' + app
  });
}

function loadOperation(key) {
  return query`RETURN DOCUMENT(${operationsColl}, ${key})`.toArray()[0];
}

function upsertOperation(op) {
  if (!operationsColl.exists(op.hash)) {
    op._key = op.hash;
    operationsColl.insert(op);
  } else {
    operationsColl.replace(op.hash, op);
  }
}

function getState() {
  const lastProcessedBlock = variablesColl.document('LAST_BLOCK').value;
  const verificationsBlock = variablesColl.document('VERIFICATION_BLOCK').value;
  const initOp = operationsColl.byExample({'state': 'init'}).toArray().length;
  const sentOp = operationsColl.byExample({'state': 'sent'}).toArray().length;
  return {
    lastProcessedBlock,
    verificationsBlock,
    initOp,
    sentOp
  }
}

module.exports = {
  connect,
  addConnection,
  removeConnection,
  createGroup,
  deleteGroup,
  addAdmin,
  addMembership,
  deleteMembership,
  updateEligibleGroups,
  invite,
  dismiss,
  userConnections,
  userGroups,
  loadUser,
  userInvitedGroups,
  createUser,
  groupMembers,
  userScore,
  getContext,
  getApp,
  getApps,
  appToDic,
  userVerifications,
  getUserByContextId,
  getContextIdsByUser,
  sponsor,
  isSponsored,
  linkContextId,
  loadOperation,
  upsertOperation,
  setRecoveryConnections,
  setSigningKey,
  getLastContextIds,
  unusedSponsorship,
  getState,
  getReporters,
  getRecoveryConnections
};