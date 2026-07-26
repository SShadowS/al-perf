tableextension 50976 "Merge Orphan Lookup Ext" extends "Merge Absent Lookup"
{
    fields
    {
        field(50000; "Orphan Lookup Only"; Text[100])
        {
            FieldClass = FlowField;
            CalcFormula = Lookup("Test Table".Description where("No." = field("No.")));
        }
    }
}
