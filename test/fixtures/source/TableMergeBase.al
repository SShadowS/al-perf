table 50970 "Merge Base"
{
    fields
    {
        field(1; "No."; Code[20])
        {
        }
        field(2; "Posting Date"; Date)
        {
        }
        field(3; Description; Text[100])
        {
        }
        field(4; "Base Total"; Decimal)
        {
            FieldClass = FlowField;
            CalcFormula = Sum("Test Table".Amount where("No." = field("No.")));
        }
        field(5; "Guarded Total"; Decimal)
        {
            // The FIELD is unguarded; only the CalcFormula sits inside a
            // preprocessor conditional. Base-app fields do this routinely —
            // FSCustomerAsset.MasterAssetName is one — and without descending
            // into the preproc node the field indexes as a FlowField with no
            // formula at all.
            FieldClass = FlowField;
#if not CLEAN25
            CalcFormula = Sum("Test Table".Amount where("No." = field("No.")));
#endif
        }
        field(6; "Guarded Relation"; Code[20])
        {
#if not CLEAN25
            TableRelation = "Test Table"."No.";
#endif
        }
    }

    keys
    {
        key(PK; "No.")
        {
            Clustered = true;
        }
        key(ByDate; "Posting Date")
        {
        }
    }
}
