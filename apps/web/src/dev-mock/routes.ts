// LOCAL MOCK (not for commit). Route table for the dev gateway mock.
import {
  buildSchema,
  type GraphQLFieldResolver,
  type GraphQLOutputType,
  graphql,
  isEnumType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
} from 'graphql';
import schemaSource from '../../../../static_assets/schema.graphql?raw';
import { bootstrapResponses } from '../../tests/native/fixtures/bootstrap';
import './campaigns';
import { route } from './index';
import {
  companies,
  contacts,
  soupAstPage,
  soupResolver,
  team,
  user,
} from './soup';

for (const [key, { body, status }] of bootstrapResponses) {
  route(key, () =>
    status && status >= 400
      ? new Response(JSON.stringify(body), { status })
      : body
  );
}

route('GET /auth/user/legacy_user_permissions', () => user.identity);
route('GET /auth/user/me', () => ({ user_id: user.id, permissions: [] }));
route('GET /auth/user/name', () => user.name);
route('GET /auth/team', () => team);
route('GET /auth/team/user', () => [team.team]);
route('POST /dss/items/soup/ast', ({ body }) =>
  soupAstPage((body ?? {}) as Record<string, unknown>)
);
for (const company of companies) {
  route(`GET /dss/crm/companies/${company.id}`, () => ({
    ...company,
    contacts: contacts.filter((c) => c.companyId === company.id),
  }));
}
for (const contact of contacts)
  route(`GET /dss/crm/contacts/${contact.id}`, () => contact);
route('GET /dss/crm/pipelines', () => []);
route('GET /dss/crm/email-privacy', () => ({ enabled: false }));

const schema = buildSchema(schemaSource);

/** A type-correct empty value, so sample items only set what the UI shows. */
function emptyValue(type: GraphQLOutputType): unknown {
  if (!isNonNullType(type)) return null;
  const inner = type.ofType;
  if (isListType(inner)) return [];
  if (isEnumType(inner)) return inner.getValues()[0]?.value ?? null;
  if (isObjectType(inner)) return {};
  if (isScalarType(inner)) {
    switch (inner.name) {
      case 'Boolean':
        return false;
      case 'Int':
      case 'Float':
        return 0;
      case 'DateTime':
        return '2026-11-10T09:00:00Z';
      case 'JSON':
        return {};
      default:
        return '';
    }
  }
  return null;
}

const fieldResolver: GraphQLFieldResolver<unknown, unknown> = (
  source,
  args,
  context,
  info
) => {
  const value =
    source && typeof source === 'object'
      ? (source as Record<string, unknown>)[info.fieldName]
      : undefined;
  if (typeof value === 'function') return value(args, context, info);
  return value === undefined ? emptyValue(info.returnType) : value;
};

route('POST /dss/items/soup/graphql', async ({ body }) => {
  const request = body as {
    query: string;
    operationName?: string;
    variables?: Record<string, unknown>;
  };
  const operation = request.operationName ?? '';
  const result = await graphql({
    schema,
    source: request.query,
    variableValues: request.variables,
    operationName: request.operationName,
    fieldResolver,
    rootValue: {
      user: {
        id: user.id,
        soup: ({ input }: { input: unknown }) => soupResolver(input, operation),
      },
    },
  });
  if (result.errors?.length)
    console.warn('[dev-mock]', operation, result.errors);
  return result;
});
