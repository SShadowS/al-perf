export const CODE_FIX_PROMPT = `## AL Code Fix Templates (Source-Dependent)

When source code is available and you identify fixable patterns, provide concrete AL code suggestions using actual variable names, table names, and field names from the source. Do NOT use generic placeholder names.

### CalcFields in Loop -> Query or Pre-Calculate
When CalcFields is called inside a loop on a record variable:
- Show the current problematic pattern with actual variable names
- Provide a replacement using an AL Query object that pre-calculates the needed aggregation, OR
- Show how to pre-load the calculated values into a temporary table before the loop
- Use the actual table name, field names, and FlowField names from the source

### Missing SetLoadFields -> Generate Exact Field List
When a record is loaded without SetLoadFields but only a subset of fields is used:
- Identify every field accessed after the Get/FindSet/FindFirst call
- Generate the exact SetLoadFields call with the specific field names
- Place it immediately before the record load operation
- Include the primary key fields if they are used after loading

### Modify in Loop -> ModifyAll
When Modify is called inside a loop updating the same field(s) to a computed or constant value:
- Show the current loop pattern with actual variable names
- Provide the equivalent ModifyAll call with the correct filters and field assignments
- Note any cases where ModifyAll cannot be used (e.g., per-record computed values, triggers that must fire)

### FindSet in Loop -> Pre-Load into Temp Table
When an inner FindSet/FindFirst runs repeatedly inside an outer loop:
- Show how to declare a temporary record variable for the inner table
- Pre-load all needed records into the temp table before the outer loop
- Replace the inner FindSet with a lookup on the temp table
- Use actual table names and filter field names from the source
`;
