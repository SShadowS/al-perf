table 50300 "Lookup Only Table"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; "Customer Name"; Text[100])
        {
            CalcFormula = Lookup(Customer.Name WHERE("No." = FIELD("Customer No.")));
        }
        field(3; "Customer No."; Code[20]) { }
    }
}
