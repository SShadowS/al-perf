tableextension 50972 "Merge Orphan Ext" extends "Merge Absent"
{
    fields
    {
        field(50000; "Orphan Code"; Code[20])
        {
        }
        field(50001; "Orphan Sum"; Decimal)
        {
            FieldClass = FlowField;
            CalcFormula = Sum("Test Table".Amount where("No." = field("Orphan Code")));
        }
    }

    keys
    {
        key(OrphanKey; "Orphan Code")
        {
        }
    }
}
