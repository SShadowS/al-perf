report 50909 "Two DataItem Report"
{
    UsageCategory = ReportsAndAnalysis;
    ApplicationArea = All;

    // Pins the whole-branch-review blocker: triggers are NOT name-unique
    // within an object. Two dataitems (header + lines -- the single most
    // ordinary BC report shape) each get their own OnAfterGetRecord member,
    // both literally named "OnAfterGetRecord". matchToSource used to collapse
    // both onto member #1 (Customer), reporting its CalcFields TWICE while
    // Vendor's CalcFields and Modify were never analyzed at all.
    dataset
    {
        dataitem(Customer; Customer)
        {
            trigger OnAfterGetRecord()
            begin
                // OnAfterGetRecord runs once per dataitem row -- no
                // repeat/for/foreach/while anywhere in this file.
                Customer.CalcFields("Balance (LCY)");
            end;
        }
        dataitem(Vendor; Vendor)
        {
            trigger OnAfterGetRecord()
            begin
                Vendor.CalcFields("Balance (LCY)");
                Vendor.Modify();
            end;
        }
    }
}
