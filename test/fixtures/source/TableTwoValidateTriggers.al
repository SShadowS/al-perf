table 50931 "Two Validate Table"
{
    // Pins the whole-branch-review blocker on the SECOND real shape: two
    // fields' OnValidate triggers, both literally named "OnValidate", sharing
    // this table's objectId. Table triggers are NOT per-row (see "does not
    // promote table triggers" in source-patterns.test.ts) -- so each needs a
    // genuine syntactic loop to be detected at all, unlike the report case.
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; "Customer No."; Code[20])
        {
            trigger OnValidate()
            var
                Cust: Record Customer;
                i: Integer;
            begin
                // Field 1's OnValidate: a genuine in-loop record op.
                for i := 1 to 10 do
                    Cust.CalcFields(Balance);
            end;
        }
        field(3; "Related No."; Code[20])
        {
            trigger OnValidate()
            var
                Related: Record "Two Validate Table";
            begin
                // Field 2's OnValidate: a plain repeat...until loop with a
                // real Modify() inside -- a genuine critical modify-in-loop,
                // not an implicit-loop edge case.
                if Related.FindSet() then
                    repeat
                        Related.Modify();
                    until Related.Next() = 0;
            end;
        }
    }
}
