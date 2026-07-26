tableextension 50971 "Merge Base Ext" extends "Merge Base"
{
    fields
    {
        field(50000; "Ext Code"; Code[20])
        {
        }
        field(50001; "Ext Lookup"; Text[100])
        {
            FieldClass = FlowField;
            CalcFormula = Lookup("Test Table".Description where("No." = field("No.")));
        }
        field(50002; "Ext Date Filter"; Date)
        {
            FieldClass = FlowFilter;
        }
    }

    keys
    {
        // Deliberately reuses the root's secondary key NAME. Legal in AL as
        // long as the key holds no base-table fields, so a merge that
        // deduplicates by key name would silently drop this index.
        key(ByDate; "Ext Code")
        {
        }
        key(ByExtCode2; "Ext Code")
        {
        }
    }
}
