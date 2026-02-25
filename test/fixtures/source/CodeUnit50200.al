codeunit 50200 "Advanced Patterns"
{
    procedure ProcessNestedLoops()
    var
        SalesLine: Record "Sales Line";
        Item: Record Item;
    begin
        SalesLine.SetRange("Document Type", SalesLine."Document Type"::Order);
        SalesLine.FindSet();
        repeat
            Item.SetRange("No.", SalesLine."No.");
            if Item.FindSet() then
                repeat
                    Item.CalcFields("Inventory");
                until Item.Next() = 0;
        until SalesLine.Next() = 0;
    end;

    procedure UnfilteredQuery()
    var
        Customer: Record Customer;
    begin
        Customer.FindSet();
        repeat
            Customer.CalcFields("Balance (LCY)");
        until Customer.Next() = 0;
    end;

    procedure FilteredQuery()
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.SetRange("Document No.", 'SO-001');
        SalesLine.SetLoadFields("No.", "Quantity");
        SalesLine.FindSet();
    end;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sales-Post", 'OnBeforePostSalesDoc', '', true, true)]
    local procedure OnBeforePostSalesDoc(var SalesHeader: Record "Sales Header")
    var
        SalesLine: Record "Sales Line";
    begin
        SalesLine.SetRange("Document No.", SalesHeader."No.");
        SalesLine.FindSet();
        repeat
            SalesLine.TestField("Quantity");
        until SalesLine.Next() = 0;
    end;
}
