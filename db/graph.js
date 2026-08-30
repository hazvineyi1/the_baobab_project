// Walks over the family graph.
//
// The tree is bipartite: people connect to unions, unions connect to people.
// A person's parents are the partners of the union they are a child of; a
// person's children are the children of every union they are a partner in.
// Everything below is a traversal of that one structure.

// Every ancestor of a person, at any depth.
// Walks child -> their parent union -> that union's partners -> upward.
const ANCESTORS = `
  WITH RECURSIVE anc AS (
    SELECT up.person_id AS id
      FROM union_children uc
      JOIN union_partners up ON up.union_id = uc.union_id
     WHERE uc.person_id = $1
    UNION
    SELECT up2.person_id
      FROM anc
      JOIN union_children uc2 ON uc2.person_id = anc.id
      JOIN union_partners up2 ON up2.union_id = uc2.union_id
  )
  SELECT id FROM anc`;

// Every descendant of a person, at any depth.
// Walks partner -> their union -> that union's children -> downward.
const DESCENDANTS = `
  WITH RECURSIVE dsc AS (
    SELECT uc.person_id AS id
      FROM union_partners up
      JOIN union_children uc ON uc.union_id = up.union_id
     WHERE up.person_id = $1
    UNION
    SELECT uc2.person_id
      FROM dsc
      JOIN union_partners up2 ON up2.person_id = dsc.id
      JOIN union_children uc2 ON uc2.union_id = up2.union_id
  )
  SELECT id FROM dsc`;

async function ancestorsOf(client, personId) {
  const { rows } = await client.query(ANCESTORS, [personId]);
  return new Set(rows.map(r => r.id));
}

async function descendantsOf(client, personId) {
  const { rows } = await client.query(DESCENDANTS, [personId]);
  return new Set(rows.map(r => r.id));
}

// The one union whose children contain this person. At most one, guaranteed by
// union_children's primary key.
async function parentUnionOf(client, personId) {
  const { rows } = await client.query(
    'SELECT union_id FROM union_children WHERE person_id = $1', [personId]);
  return rows.length ? rows[0].union_id : null;
}

// Every union this person is a partner in. More than one is normal —
// remarriage — and each union carries its own children.
async function unionsOf(client, personId) {
  const { rows } = await client.query(
    'SELECT union_id FROM union_partners WHERE person_id = $1 ORDER BY union_id', [personId]);
  return rows.map(r => r.union_id);
}

// Index of this person within their parent union's children, eldest first.
async function birthRank(client, personId) {
  const { rows } = await client.query(`
    SELECT rank FROM (
      SELECT person_id, row_number() OVER (ORDER BY birth_order) - 1 AS rank
        FROM union_children
       WHERE union_id = (SELECT union_id FROM union_children WHERE person_id = $1)
    ) t WHERE person_id = $1`, [personId]);
  return rows.length ? Number(rows[0].rank) : null;
}

const partnersOf = async (client, unionId) =>
  (await client.query(
    'SELECT person_id FROM union_partners WHERE union_id = $1 ORDER BY position', [unionId]
  )).rows.map(r => r.person_id);

const childrenOf = async (client, unionId) =>
  (await client.query(
    'SELECT person_id FROM union_children WHERE union_id = $1 ORDER BY birth_order', [unionId]
  )).rows.map(r => r.person_id);

module.exports = {
  ancestorsOf, descendantsOf, parentUnionOf, unionsOf, birthRank,
  partnersOf, childrenOf, ANCESTORS, DESCENDANTS
};
